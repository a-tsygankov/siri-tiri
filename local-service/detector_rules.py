"""Calibration-only diagnostics, explicit immutable rule freeze and held-out evaluation."""
import uuid

import detector_features as features
from review_artifacts import fingerprint, save_document, utc_now
from review_store import TARGET, validate_catalog

LIMITATIONS = [
    'Target: at least one audible meow anywhere in the clip; not intent or all cat vocalizations.',
    'Earlier descriptive baseline exposed both groups; held out from this calibration code, not never inspected.',
    'Owner/environment overlap across cats is not controlled; no Tiri/household accuracy claim.',
    'Human review is a local user assertion, not authenticated proof of listening.',
]


def metrics(rows, score, threshold):
    counts = dict(tp=0, tn=0, fp=0, fn=0)
    for row in rows:
        positive = row['label'] == 'positive'
        predicted = row['features'][score] >= threshold
        counts['tp' if positive and predicted else 'fn' if positive else 'fp' if predicted else 'tn'] += 1
    tp, tn, fp, fn = (counts[key] for key in ('tp', 'tn', 'fp', 'fn'))
    return dict(confusion=counts, positiveCount=tp + fn, negativeCount=tn + fp,
                precision=tp / (tp + fp) if tp + fp else None,
                recall=tp / (tp + fn) if tp + fn else None,
                falsePositiveRate=fp / (fp + tn) if fp + tn else None,
                accuracy=(tp + tn) / len(rows) if rows else None,
                f1=2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None)


def partition(catalog, document, split):
    indexed = features.validate(document, catalog)
    rows = []
    coverage = dict(partition=split, total=0, positive=0, negative=0, referencePositive=0, humanPositive=0,
                    humanNegative=0, excludedUnreviewed=0, excludedUncertain=0, unresolvedGroup=0,
                    failedEligible=0, scoredEligible=0)
    failures = []
    for entry in catalog['clips']:
        if not entry['groupResolved']:
            coverage['unresolvedGroup'] += 1
            continue
        if entry['split'] != split:
            continue
        coverage['total'] += 1
        label = entry['effectiveLabel']
        if label is None:
            coverage['excludedUnreviewed'] += 1
            continue
        if label == 'uncertain':
            coverage['excludedUncertain'] += 1
            continue
        coverage[label] += 1
        if label == 'positive':
            coverage['humanPositive' if entry['labelSource'] == 'human' else 'referencePositive'] += 1
        else:
            if entry['labelSource'] != 'human' or entry['revision'] < 1:
                raise ValueError('negative requires human review')
            coverage['humanNegative'] += 1
        feature = indexed.get(entry['clipId'])
        if feature is None or feature['status'] != 'scored':
            coverage['failedEligible'] += 1
            failures.append(dict(clipId=entry['clipId'], errorCode='compatible_features_missing_or_failed'))
            continue
        coverage['scoredEligible'] += 1
        rows.append(dict(clipId=entry['clipId'], sourceSha256=entry['sourceSha256'], groupId=entry['catId'],
                         sessionId=entry['sessionId'], split=split, label=label, labelSource=entry['labelSource'],
                         revision=entry['revision'], reviewer=entry['reviewer'], reviewedAt=entry['reviewedAt'],
                         features=feature['features'], featureFingerprint=features.feature_fingerprint(feature, document['provenance'])))
    return sorted(rows, key=lambda row: row['clipId']), coverage, failures


def reasons(coverage, split):
    result = []
    if not coverage['positive']:
        result.append('positive_' + split + '_examples_required')
    if not coverage['negative']:
        result.append('negative_' + split + '_examples_required')
    if coverage['failedEligible']:
        result.append('eligible_features_incomplete')
    return result


def calibrate(catalog, document):
    rows, coverage, failures = partition(catalog, document, 'calibration')
    blocked = reasons(coverage, 'calibration')
    candidates = [] if blocked else [dict(score=score, threshold=threshold, metrics=metrics(rows, score, threshold))
                                     for score in features.SCORES for threshold in (.1, .2, .3, .4, .5, .6, .7, .8, .9)]
    return dict(schemaVersion=1, artifactType='detectorCalibration', target=TARGET, generatedAt=utc_now(),
                synthetic=document['synthetic'], provenance=features.provenance(),
                inventoryFingerprint=catalog['inventoryFingerprint'], calibrationFingerprint=fingerprint(rows),
                status='insufficient_calibration_data' if blocked else 'ready_for_explicit_freeze',
                reasons=blocked, coverage=coverage, failures=failures, candidates=candidates,
                selectedRule=None, limitations=LIMITATIONS)


def freeze(catalog, document, score, threshold, root):
    if score not in features.SCORES or not features.finite_score(threshold):
        raise ValueError('invalid score or threshold')
    rows, coverage, failures = partition(catalog, document, 'calibration')
    blocked = reasons(coverage, 'calibration')
    if blocked:
        raise ValueError('cannot freeze: ' + ','.join(blocked))
    rule = dict(schemaVersion=1, artifactType='frozenDetectorRule', ruleId=str(uuid.uuid4()), target=TARGET,
                generatedAt=utc_now(), synthetic=document['synthetic'], provenance=features.provenance(),
                inventoryFingerprint=catalog['inventoryFingerprint'], score=score, threshold=threshold,
                comparison='>=', calibrationSnapshot=rows, calibrationFingerprint=fingerprint(rows),
                calibrationCoverage=coverage, calibrationMetrics=metrics(rows, score, threshold),
                limitations=LIMITATIONS)
    rule['artifactFingerprint'] = fingerprint(rule)
    return save_document(root, 'rule', rule)


def validate_rule(rule, catalog, document):
    try:
        body = {key: value for key, value in rule.items() if key != 'artifactFingerprint'}
        if (rule['artifactFingerprint'] != fingerprint(body) or type(rule['schemaVersion']) is not int
                or rule['schemaVersion'] != 1 or rule['artifactType'] != 'frozenDetectorRule'
                or rule['target'] != TARGET or rule['provenance'] != features.provenance()
                or type(rule['synthetic']) is not bool or rule['synthetic'] != document['synthetic']
                or rule['inventoryFingerprint'] != catalog['inventoryFingerprint'] or rule['comparison'] != '>='
                or rule['score'] not in features.SCORES or not features.finite_score(rule['threshold'])):
            raise ValueError('frozen rule integrity/provenance mismatch')
        rows, ids = rule['calibrationSnapshot'], set()
        if not isinstance(rows, list) or not rows or fingerprint(rows) != rule['calibrationFingerprint']:
            raise ValueError('calibration snapshot mismatch')
        known = {row['clipId']: row for row in catalog['clips']}
        for row in rows:
            entry = known.get(row['clipId'])
            if (entry is None or row['clipId'] in ids or row['split'] != 'calibration'
                    or entry['split'] != 'calibration' or row['groupId'] != entry['catId']
                    or row['sessionId'] != entry['sessionId'] or row['sourceSha256'] != entry['sourceSha256']
                    or row['label'] not in ('positive', 'negative')
                    or set(row['features']) != set(features.SCORES)
                    or not all(features.finite_score(value) for value in row['features'].values())
                    or row['features']['cat_or_meow_max'] < row['features']['meow_max']
                    or row['featureFingerprint'] != features.feature_fingerprint(row, rule['provenance'])):
                raise ValueError('invalid frozen calibration record')
            if row['labelSource'] == 'dataset_reference':
                if row['label'] != 'positive' or row['revision'] != 0 or entry['referenceLabel'] != 'positive':
                    raise ValueError('invalid frozen reference label')
            else:
                if row['labelSource'] != 'human' or type(row['revision']) is not int or not 1 <= row['revision'] <= len(entry['history']):
                    raise ValueError('invalid frozen human review')
                historical = entry['history'][row['revision'] - 1]
                if any(row[key] != historical[key] for key in ('label', 'reviewer', 'reviewedAt')):
                    raise ValueError('frozen review does not match immutable history')
            ids.add(row['clipId'])
        if {row['label'] for row in rows} != {'positive', 'negative'}:
            raise ValueError('frozen rule lacks calibration class coverage')
        if rule['calibrationMetrics'] != metrics(rows, rule['score'], rule['threshold']):
            raise ValueError('frozen calibration metrics mismatch')
        return rows
    except (KeyError, TypeError, AttributeError):
        raise ValueError('invalid frozen detector rule') from None


def evaluate(catalog, document, rule):
    validate_catalog(catalog)
    features.validate(document, catalog)
    calibration = validate_rule(rule, catalog, document)
    rows, coverage, failures = partition(catalog, document, 'evaluation')
    calibration_groups = {row['groupId'] for row in calibration}
    calibration_content = {row['sourceSha256'] for row in calibration}
    if any(row['groupId'] in calibration_groups or row['sourceSha256'] in calibration_content for row in rows):
        raise ValueError('calibration/evaluation leakage')
    blocked = reasons(coverage, 'evaluation')
    return dict(schemaVersion=1, artifactType='detectorEvaluation', target=TARGET, generatedAt=utc_now(),
                synthetic=rule['synthetic'], ruleId=rule['ruleId'], ruleFingerprint=rule['artifactFingerprint'],
                provenance=rule['provenance'], calibrationFingerprint=rule['calibrationFingerprint'],
                evaluationFingerprint=fingerprint(rows), evaluationSnapshot=rows,
                status='insufficient_evaluation_data' if blocked else 'evaluated', reasons=blocked,
                coverage=coverage, failures=failures,
                metrics=None if blocked else metrics(rows, rule['score'], rule['threshold']), limitations=LIMITATIONS)
