"""Project-local setup and operations. Run with Python; no shell activation needed."""
import argparse
import http.client
import json
import math
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
import time
import uuid
import venv

import model_assets

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
VENV = REPO / '.venv'
PYTHON = VENV / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def child_options():
    return {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}


def environment():
    env = os.environ.copy()
    temporary = VENV / 'tmp'
    temporary.mkdir(parents=True, exist_ok=True)
    env.update(TEMP=str(temporary), TMP=str(temporary), TMPDIR=str(temporary), PYTHONDONTWRITEBYTECODE='1')
    return env


def setup(with_catmeows=False):
    if sys.platform != 'win32' or sys.version_info[:2] != (3, 13) or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise RuntimeError('inference_setup_requires_windows_x64_python313; core API supports Python 3.11+')
    env = environment()
    old = os.environ.copy()
    try:
        os.environ.update(env)
        if not PYTHON.is_file():
            venv.EnvBuilder(with_pip=True).create(VENV)
    finally:
        os.environ.clear()
        os.environ.update(old)
    version = subprocess.check_output([str(PYTHON), '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], text=True).strip()
    if version != '3.13':
        raise RuntimeError('existing_venv_requires_python313; create a compatible venv without deleting user data')
    subprocess.run([str(PYTHON), '-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:',
                    '--require-hashes', '-r', str(ROOT / 'requirements-inference-win-py313.lock')], env=env, check=True)
    model_assets.download()
    (ROOT / 'audio').mkdir(exist_ok=True)
    subprocess.run([str(PYTHON), '-B', str(ROOT / 'manage.py'), 'smoke'], env=env, check=True)
    if with_catmeows:
        import catmeows
        catmeows.provision()
    else:
        print('Optional CatMeows research data: https://zenodo.org/records/4008297; run manage.py catmeows', flush=True)
    print('Setup verified. Run: py -3 "%s" run' % (ROOT / 'manage.py'), flush=True)


def require_environment():
    if not PYTHON.is_file():
        raise RuntimeError('local_venv_missing; run setup first')


def health(port):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
    try:
        connection.request('GET', '/health')
        response = connection.getresponse()
        data = response.read(8193)
        if response.status != 200 or len(data) > 8192:
            raise RuntimeError('api_unhealthy')
        return json.loads(data)
    finally:
        connection.close()


def stop_children(children):
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
    for child in reversed(children):
        try:
            child.wait(timeout=6)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)


def worker_command(port, audio_root, once=False):
    return [str(PYTHON), '-B', str(ROOT / 'worker.py'), '--port', str(port),
            '--audio-root', str(Path(audio_root).resolve())] + (['--once'] if once else [])


def run_stack(port, database, audio_root):
    try:
        with socket.socket() as probe:
            if os.name == 'nt':
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind(('127.0.0.1', port))
    except OSError:
        raise RuntimeError('port_in_use; stop the existing service or select another port') from None
    require_environment()
    model_assets.verify(model_assets.MODEL_PATH)
    # Fail before API startup if dependencies/model cannot execute.
    subprocess.run([str(PYTHON), '-B', str(ROOT / 'manage.py'), 'smoke'], env=environment(), check=True)
    env = environment()
    instance = str(uuid.uuid4())
    env.update(SIRI_TIRI_DB=str(Path(database).resolve()), SIRI_TIRI_PORT=str(port), SIRI_TIRI_INSTANCE_ID=instance)
    children = []
    try:
        api = subprocess.Popen([str(PYTHON), '-B', '-u', str(ROOT / 'service.py')], env=env, **child_options())
        children.append(api)
        deadline = time.monotonic() + 15
        while True:
            if api.poll() is not None:
                raise RuntimeError('api_startup_failed')
            try:
                response = health(port)
                if response.get('instanceId') != instance or response.get('version') != '0.3.0':
                    raise RuntimeError('unexpected_api_instance')
                break
            except (OSError, http.client.HTTPException):
                if time.monotonic() >= deadline:
                    raise RuntimeError('api_startup_timeout') from None
                time.sleep(0.1)
        children.append(subprocess.Popen(worker_command(port, audio_root), env=env, **child_options()))
        print('API and YAMNet worker running at http://127.0.0.1:%d; Ctrl+C stops both.' % port, flush=True)
        while True:
            if any(child.poll() is not None for child in children):
                raise RuntimeError('stack_child_exited')
            time.sleep(0.25)
    except KeyboardInterrupt:
        return 0
    finally:
        stop_children(children)


def model_smoke():
    from inference import Yamnet
    from dataset_prepare import resample_pcm16
    import array
    resampled, clipped = resample_pcm16(array.array('h', [0] * 8))
    if list(resampled) != [0] * 16 or clipped:
        raise RuntimeError('resampling_smoke_failed')
    model = Yamnet()
    results = [model.analyze([0.] * 16000),
               model.analyze([0.1 * math.sin(2 * math.pi * 440 * i / 16000) for i in range(16000)])]
    if results[0]['topClasses'][0]['label'] != 'Silence':
        raise RuntimeError('model_silence_smoke_failed')
    print(json.dumps(dict(status='ok', modelVersion=model_assets.MANIFEST['modelVersion'],
                          sha256=model_assets.MANIFEST['sha256'], syntheticChecks=['silence', '440Hz-tone', '8k-to16k-resampling'])), flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('tests', 'smoke', 'paths', 'catmeows'):
        sub.add_parser(name)
    setup_parser = sub.add_parser('setup')
    setup_parser.add_argument('--catmeows', action='store_true', help='Also download CatMeows for non-commercial research: https://zenodo.org/records/4008297')
    for name in ('run', 'api', 'worker', 'status'):
        p = sub.add_parser(name)
        p.add_argument('--port', type=int, default=8765)
        if name in ('run', 'api'):
            p.add_argument('--db', type=Path, default=ROOT / 'data' / 'siri-tiri.sqlite3')
        if name in ('run', 'worker'):
            p.add_argument('--audio-root', type=Path, default=ROOT / 'audio')
        if name == 'worker':
            p.add_argument('--once', action='store_true')
    analyze = sub.add_parser('analyze')
    analyze.add_argument('wav', type=Path)
    for name in ('prepare-catmeows', 'evaluate-catmeows'):
        dataset = sub.add_parser(name)
        dataset.add_argument('--dataset-root', type=Path, default=REPO / 'CatMeows')
        if name == 'evaluate-catmeows':
            dataset.add_argument('--manifest', type=Path)
            dataset.add_argument('--reports', type=Path)
            dataset.add_argument('--limit', type=int, help='Explicitly labeled subset for debugging')
    review_commands = ('review-init', 'review-export', 'review-label', 'review-score',
                       'detector-calibrate', 'detector-freeze', 'detector-evaluate')
    for name in review_commands:
        command = sub.add_parser(name)
        command.add_argument('--dataset-root', type=Path, default=REPO / 'CatMeows')
        if name == 'review-label':
            command.add_argument('--clip-id', required=True)
            command.add_argument('--label', choices=('positive', 'negative', 'uncertain'), required=True)
            command.add_argument('--reviewer', required=True)
            command.add_argument('--expected-revision', type=int, required=True)
            command.add_argument('--note', default='')
        if name.startswith('detector-'):
            command.add_argument('--features', type=Path, required=True)
        if name == 'detector-freeze':
            command.add_argument('--score', choices=('meow_max', 'cat_or_meow_max'), required=True)
            command.add_argument('--threshold', type=float, required=True)
        if name == 'detector-evaluate':
            command.add_argument('--rule', type=Path, required=True)
    args = parser.parse_args(argv)
    if hasattr(args, 'port') and not 1 <= args.port <= 65535:
        parser.error('port must be 1..65535')
    if args.command == 'paths':
        print(json.dumps(dict(root=str(ROOT), python=str(PYTHON), model=str(model_assets.MODEL_PATH))))
        return 0
    if args.command == 'setup':
        setup(args.catmeows)
        return 0
    if args.command == 'catmeows':
        import catmeows
        catmeows.provision()
        return 0
    if args.command == 'status':
        print(json.dumps(health(args.port)))
        return 0
    if args.command == 'run':
        return run_stack(args.port, args.db, args.audio_root)
    if args.command in review_commands:
        return review_command(args, argv)
    if args.command in ('smoke', 'analyze', 'prepare-catmeows', 'evaluate-catmeows'):
        require_environment()
        if Path(sys.executable).resolve() != PYTHON.resolve():
            return subprocess.call([str(PYTHON), '-B', str(ROOT / 'manage.py')] + (sys.argv[1:] if argv is None else argv), env=environment())
        if args.command == 'smoke':
            model_smoke()
        elif args.command == 'analyze':
            from inference import Yamnet, load_wav
            print(json.dumps(Yamnet().analyze(load_wav(args.wav))))
        elif args.command == 'prepare-catmeows':
            from dataset_prepare import prepare_catmeows
            print('Prepared manifest: ' + str(prepare_catmeows(args.dataset_root)))
        else:
            from dataset_prepare import VERSION
            from dataset_evaluate import evaluate
            manifest = args.manifest or args.dataset_root / 'derived' / VERSION / 'manifest.json'
            path = evaluate(manifest, args.reports or args.dataset_root / 'reports', limit=args.limit)
            print('Batch report: ' + str(path), flush=True)
            if json.loads(path.read_text(encoding='utf-8'))['failedCount']:
                return 1
        return 0
    if args.command == 'tests':
        python = PYTHON if PYTHON.is_file() else Path(sys.executable)
        return subprocess.call([str(python), '-B', '-m', 'unittest', 'discover', '-s', str(ROOT / 'tests'), '-v'], env=environment())
    require_environment()
    if args.command == 'worker':
        return subprocess.call(worker_command(args.port, args.audio_root, args.once), env=environment())
    env = environment()
    env.update(SIRI_TIRI_DB=str(args.db.resolve()), SIRI_TIRI_PORT=str(args.port))
    return subprocess.call([str(PYTHON), '-B', str(ROOT / 'service.py')], env=env)


def review_command(args, argv=None):
    from review_store import ReviewStore, catmeows_inventory
    from review_artifacts import export_catalog, read_document, save_document
    store = ReviewStore(args.dataset_root)
    if args.command == 'review-init':
        snapshot = store.initialize(catmeows_inventory(args.dataset_root))
    elif args.command == 'review-label':
        revision = store.label(args.clip_id, args.label, args.reviewer, args.expected_revision, args.note)
        print(json.dumps(dict(clipId=args.clip_id, revision=revision, status='saved')))
        return 0
    else:
        snapshot = store.snapshot()
    if args.command == 'review-init':
        print(json.dumps(dict(clips=len(snapshot['clips']),
                              datasetReference=sum(row['labelSource'] == 'dataset_reference' for row in snapshot['clips']),
                              unreviewed=sum(row['reviewStatus'] == 'unreviewed' for row in snapshot['clips']),
                              humanReviewed=sum(row['labelSource'] == 'human' for row in snapshot['clips']))))
        return 0
    if args.command == 'review-export':
        print('Review snapshot: ' + str(export_catalog(args.dataset_root / 'reviews' / 'exports', snapshot)))
        return 0
    if args.command == 'review-score':
        require_environment()
        if Path(sys.executable).resolve() != PYTHON.resolve():
            return subprocess.call([str(PYTHON), '-B', str(ROOT / 'manage.py')] + (sys.argv[1:] if argv is None else argv), env=environment())
        from detector_features import score_catalog
        path = score_catalog(snapshot, args.dataset_root)
        print('Review features: ' + str(path), flush=True)
        return 0 if all(row['status'] == 'scored' for row in read_document(path)['rows']) else 1
    import detector_rules
    document = read_document(args.features)
    if args.command == 'detector-freeze':
        path = detector_rules.freeze(snapshot, document, args.score, args.threshold, args.dataset_root / 'reviews' / 'rules')
        print('Frozen rule: ' + str(path))
        return 0
    if args.command == 'detector-calibrate':
        report = detector_rules.calibrate(snapshot, document)
    else:
        report = detector_rules.evaluate(snapshot, document, read_document(args.rule))
    path = save_document(args.dataset_root / 'reviews' / 'reports', args.command, report)
    print(json.dumps(dict(status=report['status'], reasons=report['reasons'], report=str(path))))
    return 2 if report['reasons'] else 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
    except Exception as error:
        print('Local command failed: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
