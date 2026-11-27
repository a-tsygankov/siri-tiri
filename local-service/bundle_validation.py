"""Bounded export-v1 validation. Owner reviews remain independent evidence."""
from datetime import datetime
import json
import math
from pathlib import Path
import re

MAX_JSON = 16 * 1024 * 1024
MAX_ROWS = 10000
UUID = re.compile(r'^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')
HASH = re.compile(r'^[0-9a-f]{64}$')
CONTRACTS = Path(__file__).resolve().parents[1] / 'contracts'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def require(ok, code):
    if not ok:
        raise ValueError(code)


def read_json(data):
    require(len(data) <= MAX_JSON, 'bundle_json_too_large')
    def pairs(items):
        out = {}
        for key, value in items:
            require(key not in out, 'bundle_duplicate_json_key')
            out[key] = value
        return out
    def constant(_):
        raise ValueError('bundle_nonfinite_number')
    try:
        result = json.loads(data.decode('utf-8-sig'), object_pairs_hook=pairs, parse_constant=constant)
        canonical(result)  # Also rejects overflowing numeric literals such as 1e999.
        return result
    except (UnicodeError, RecursionError, OverflowError) as ex:
        raise ValueError('bundle_json_invalid') from ex


def date(value):
    require(isinstance(value, str) and len(value) <= 64 and 'T' in value, 'bundle_timestamp_invalid')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ValueError('bundle_timestamp_invalid') from None
    require(parsed.utcoffset() is not None, 'bundle_timestamp_timezone_required')


def schema(value, spec):
    """Subset used by current event/review contracts; fail on invalid primitives."""
    def matches(kind):
        return {'object': type(value) is dict, 'array': type(value) is list, 'string': type(value) is str,
                'integer': type(value) is int, 'number': type(value) in (int, float),
                'boolean': type(value) is bool, 'null': value is None}.get(kind, False)
    if 'type' in spec:
        kinds = spec['type'] if isinstance(spec['type'], list) else [spec['type']]
        require(any(matches(kind) for kind in kinds), 'bundle_contract_type_invalid')
    if 'const' in spec:
        require(type(value) is type(spec['const']) and value == spec['const'], 'bundle_contract_version_invalid')
    if 'enum' in spec:
        require(value in spec['enum'], 'bundle_contract_enum_invalid')
    if type(value) is dict:
        require(all(key in value for key in spec.get('required', [])), 'bundle_contract_field_missing')
        props = spec.get('properties', {})
        if spec.get('additionalProperties') is False:
            require(set(value) <= set(props), 'bundle_contract_extra_field')
        for key in value.keys() & props.keys():
            schema(value[key], props[key])
    if isinstance(value, str):
        require(spec.get('minLength', 0) <= len(value) <= spec.get('maxLength', MAX_JSON), 'bundle_string_length_invalid')
        if spec.get('format') == 'uuid':
            require(UUID.fullmatch(value), 'bundle_uuid_invalid')
        if spec.get('format') == 'date-time':
            date(value)
    if type(value) in (int, float):
        require(math.isfinite(value) and value >= spec.get('minimum', -math.inf), 'bundle_number_invalid')


def integer(value, low, high):
    require(type(value) is int and low <= value <= high, 'bundle_integer_invalid')


def identifier(value):
    require(isinstance(value, str) and UUID.fullmatch(value), 'bundle_uuid_invalid')


def hash_value(value):
    require(isinstance(value, str) and HASH.fullmatch(value), 'bundle_sha256_invalid')


def safe_name(value):
    require(isinstance(value, str) and 1 <= len(value) <= 240, 'bundle_filename_invalid')
    require(not re.search(r'[<>:"/\\|?*\x00-\x1f]', value) and value not in ('.', '..')
            and value[-1] not in ' .', 'bundle_filename_unsafe')
    require(value.split('.')[0].upper() not in {'CON', 'PRN', 'AUX', 'NUL', 'CLOCK$',
            *('COM' + str(i) for i in range(1, 10)), *('LPT' + str(i) for i in range(1, 10))}, 'bundle_filename_reserved')
    require(value.lower().endswith('.wav'), 'bundle_filename_not_wav')


def validate_capture(e):
    p = e['payload']
    require(type(p) is dict, 'bundle_capture_payload_invalid')
    identifier(p.get('clipId'))
    if 'supersedesMessageId' in p:
        identifier(p['supersedesMessageId'])
    if p.get('deleted') is True:
        require(set(p) == {'deleted', 'clipId', 'supersedesMessageId'}, 'bundle_tombstone_invalid')
        return
    required = {'clipId', 'sha256', 'sizeBytes', 'sampleRate', 'durationMs', 'clippedSamples', 'recordedAt',
                'interrupted', 'encoding', 'channels', 'captureVersion', 'sourceKind'}
    require(required <= p.keys() and p.keys() <= required | {'clockSource', 'supersedesMessageId', 'restoresMessageId', 'trim'},
            'bundle_capture_fields_invalid')
    hash_value(p['sha256'])
    integer(p['sizeBytes'], 44, 3 * 1024 * 1024)
    integer(p['sampleRate'], 16000, 48000)
    require(p['sampleRate'] in (16000, 44100, 48000), 'bundle_rate_unsupported')
    integer(p['durationMs'], 1, 30000)
    integer(p['clippedSamples'], 0, p['sampleRate'] * 30)
    require(type(p['interrupted']) is bool and p['encoding'] == 'pcm16-wav' and type(p['channels']) is int
            and p['channels'] == 1 and p['captureVersion'] == 'pwa-pcm16-native-v1'
            and p['sourceKind'] == 'pwa-manual', 'bundle_capture_format_invalid')
    if 'clockSource' in p:
        require(p['clockSource'] == 'phone', 'bundle_clock_source_invalid')
    date(p['recordedAt'])
    if 'restoresMessageId' in p:
        identifier(p['restoresMessageId'])
        require('supersedesMessageId' in p and 'trim' not in p, 'bundle_restore_invalid')
    if 'trim' in p:
        t = p['trim']
        require(type(t) is dict and set(t) == {'sourceMessageId', 'sourceClipId', 'sourceSha256',
                'sourceDurationMs', 'startMs', 'endMs', 'trimVersion'} and 'supersedesMessageId' in p,
                'bundle_trim_fields_invalid')
        identifier(t['sourceMessageId'])
        identifier(t['sourceClipId'])
        hash_value(t['sourceSha256'])
        integer(t['sourceDurationMs'], 1, 30000)
        for key in ('startMs', 'endMs'):
            require(type(t[key]) in (int, float) and math.isfinite(t[key]), 'bundle_trim_range_invalid')
        require(0 <= t['startMs'] < t['endMs'] <= t['sourceDurationMs'] and t['trimVersion'] == 'pwa-trim-v1'
                and abs(p['durationMs'] - (t['endMs'] - t['startMs'])) <= 1, 'bundle_trim_range_invalid')


def validate_bundle(doc):
    require(type(doc) is dict and set(doc) == {'exportVersion', 'protocolVersion', 'appVersion', 'installId',
            'exportedAt', 'events', 'reviews', 'clips'}, 'bundle_fields_invalid')
    for key in ('exportVersion', 'protocolVersion'):
        require(type(doc[key]) is int and doc[key] == 1, 'bundle_version_unsupported')
    require(type(doc['appVersion']) is str and 1 <= len(doc['appVersion']) <= 64, 'bundle_app_version_invalid')
    identifier(doc['installId'])
    date(doc['exportedAt'])
    for key in ('events', 'reviews', 'clips'):
        require(type(doc[key]) is list and len(doc[key]) <= MAX_ROWS, 'bundle_array_limit')
    specs = {kind: json.loads((CONTRACTS / name).read_text()) for kind, name in
             [('events', 'event.v1.schema.json'), ('reviews', 'review-v1.schema.json')]}
    messages, captures, reviews = {}, {}, []
    for kind in ('events', 'reviews'):
        for item in doc[kind]:
            schema(item, specs[kind])
            mid = item['messageId']
            if mid in messages:
                require(messages[mid] == (kind, canonical(item)), 'bundle_message_identity_conflict')
                continue
            messages[mid] = kind, canonical(item)
            if kind == 'events':
                require(item['type'] == 'capture', 'bundle_event_type_unsupported')
                validate_capture(item)
                captures[mid] = item
            else:
                revision = item['revision']
                require((revision == 1 and item.get('baseRevision') is None) or
                        (revision > 1 and type(item.get('baseRevision')) is int and item['baseRevision'] == revision - 1),
                        'bundle_review_base_invalid')
                reviews.append(item)
    by_event, by_clip = {}, {}
    for e in captures.values():
        by_event.setdefault(e['eventId'], []).append(e)
        p = e['payload']
        if not p.get('deleted'):
            identity = (e['eventId'], *(p[key] for key in ('sha256', 'sizeBytes', 'sampleRate', 'durationMs')))
            require(p['clipId'] not in by_clip or by_clip[p['clipId']][0] == identity, 'bundle_clip_identity_conflict')
            by_clip[p['clipId']] = identity, e
    for review in reviews:
        by_event.setdefault(review['eventId'], [])
    coverage = []
    for event_id, rows in by_event.items():
        issues = set()
        live = [r for r in rows if not r['payload'].get('deleted')]
        for e in rows:
            p = e['payload']
            for pointer in ('supersedesMessageId', 'restoresMessageId'):
                ref = p.get(pointer)
                if ref:
                    if ref not in captures:
                        issues.add('unresolved_history')
                    else:
                        require(captures[ref]['eventId'] == event_id, 'bundle_cross_event_reference')
            seen, cursor = set(), e['messageId']
            while cursor in captures:
                require(cursor not in seen, 'bundle_capture_cycle')
                seen.add(cursor)
                cursor = captures[cursor]['payload'].get('supersedesMessageId')
            t = p.get('trim')
            root_id = t['sourceMessageId'] if t else p.get('restoresMessageId')
            if root_id:
                if root_id not in captures:
                    issues.add('unresolved_history')
                else:
                    root = captures[root_id]
                    rp = root['payload']
                    require(root['eventId'] == event_id and not any(k in rp for k in
                            ('deleted', 'supersedesMessageId', 'restoresMessageId', 'trim')), 'bundle_trim_root_invalid')
                    if t:
                        require((t['sourceClipId'], t['sourceSha256'], t['sourceDurationMs'], p['sampleRate']) ==
                                (rp['clipId'], rp['sha256'], rp['durationMs'], rp['sampleRate']), 'bundle_trim_source_mismatch')
                    else:
                        require(all(p[k] == rp[k] for k in ('clipId', 'sha256', 'sizeBytes', 'sampleRate', 'durationMs')),
                                'bundle_restore_source_mismatch')
        superseded = {r['payload'].get('supersedesMessageId') for r in live}
        heads = [r for r in live if r['messageId'] not in superseded]
        if len(heads) > 1:
            issues.add('conflict')
        if not heads:
            issues.add('unresolved_history')
        event_reviews = [r for r in reviews if r['eventId'] == event_id]
        revisions = {}
        review_ids = {r['reviewId'] for r in event_reviews}
        if len(review_ids) > 1:
            issues.add('conflict')
        for r in event_reviews:
            if r['revision'] in revisions:
                issues.add('conflict')
            revisions[r['revision']] = r
        if revisions and (min(revisions) != 1 or len(revisions) != max(revisions)):
            issues.add('unresolved_history')
        status = ('deleted' if any(r['payload'].get('deleted') for r in rows) else
                  'conflict' if 'conflict' in issues else 'unresolved_history' if issues else 'pending')
        head = heads[0] if len(heads) == 1 else None
        coverage.append(dict(eventId=event_id, messageId=head['messageId'] if head else None,
                             clipId=head['payload']['clipId'] if head else None, status=status, issues=sorted(issues)))
    filenames, clip_rows = set(), set()
    for row in doc['clips']:
        require(type(row) is dict and set(row) == {'clipId', 'eventId', 'filename', 'sha256', 'sizeBytes',
                'sampleRate', 'durationMs'}, 'bundle_manifest_fields_invalid')
        safe_name(row['filename'])
        folded = row['filename'].casefold()
        require(folded not in filenames and row['clipId'] not in clip_rows, 'bundle_manifest_duplicate')
        filenames.add(folded)
        clip_rows.add(row['clipId'])
        require(row['clipId'] in by_clip, 'bundle_manifest_capture_missing')
        expected = by_clip[row['clipId']][0]
        require((row['eventId'], *(row[k] for k in ('sha256', 'sizeBytes', 'sampleRate', 'durationMs'))) == expected,
                'bundle_manifest_capture_mismatch')
        for key in ('sizeBytes', 'sampleRate', 'durationMs'):
            require(type(row[key]) is int, 'bundle_manifest_integer_invalid')
    return captures, coverage
