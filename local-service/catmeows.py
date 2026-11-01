"""Optional CatMeows v1.0.2 provisioning for scientific/non-commercial research."""
import json
from pathlib import Path, PurePosixPath
import stat
import tempfile
import zipfile

from model_assets import download

SOURCE = 'https://zenodo.org/records/4008297'
DESTINATION = Path(__file__).resolve().parent.parent / 'CatMeows'
ARCHIVES = (
    dict(filename='dataset.zip', size=8861099,
         sha256='214000280e6ef33b10e39ef063ccc1f2f83d789ab57f2a5d111da63b06f659ae',
         url=SOURCE + '/files/dataset.zip?download=1'),
    dict(filename='extras.zip', size=4142654,
         sha256='81d1206a632f5d5052bcd9f804be10a02a6f7a2b8ab9a35858d105483159b4f2',
         url=SOURCE + '/files/extras.zip?download=1'),
)


def extract(archives, destination):
    """Preserve archive paths; stage all files before installing a new raw tree."""
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='catmeows-', dir=destination.parent) as temporary:
        stage = Path(temporary) / 'raw'
        stage.mkdir()
        seen, total = set(), 0
        for path in archives:
            with zipfile.ZipFile(path) as archive:
                for entry in archive.infolist():
                    original = entry.orig_filename
                    relative = PurePosixPath(original)
                    if (not relative.parts or relative.is_absolute() or '..' in relative.parts
                            or ':' in original or '\\' in original or '\x00' in original
                            or stat.S_ISLNK(entry.external_attr >> 16)):
                        raise ValueError('CatMeows archive has unsafe paths or links')
                    if entry.is_dir():
                        continue
                    key = str(relative).casefold()
                    total += entry.file_size
                    if key in seen or len(seen) >= 10000 or total > 100000000:
                        raise ValueError('CatMeows archive duplicates or extraction limit exceeded')
                    seen.add(key)
                    content = archive.read(entry)  # ZIP CRC is checked as the member is read.
                    target = stage.joinpath(*relative.parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content)
        if destination.exists():
            # A repeated setup verifies raw data and never overwrites annotations/edits.
            for candidate in stage.rglob('*'):
                if candidate.is_file():
                    existing = destination / candidate.relative_to(stage)
                    if (not existing.is_file() or existing.is_symlink()
                            or not existing.resolve().is_relative_to(destination.resolve())
                            or existing.read_bytes() != candidate.read_bytes()):
                        raise ValueError('CatMeows extraction differs; move the raw folder aside before retrying')
        else:
            stage.rename(destination)


def provision(destination=DESTINATION):
    destination = Path(destination)
    archive_dir = destination / 'archives'
    archive_dir.mkdir(parents=True, exist_ok=True)
    paths = [download(archive_dir / item['filename'], item) for item in ARCHIVES]
    extract(paths, destination / 'raw')
    provenance = dict(dataset='CatMeows', version='1.0.2', doi='10.5281/zenodo.4008297', source=SOURCE,
                      terms='Scientific research and non-commercial purposes; acknowledge authors and cite source.',
                      archives=list(ARCHIVES))
    (destination / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n', encoding='utf-8')
    print('CatMeows ready: %s (scientific/non-commercial research; cite %s)' % (destination.resolve(), SOURCE), flush=True)
    return destination
