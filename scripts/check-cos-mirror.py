"""Fail closed before publishing or resuming a release on the flat COS mirror.

Uses the same bucket and Python SDK as coscmd. This is a read-only guard;
release and resync must retain their shared GitHub Actions concurrency group.
"""

import hashlib
import os
import re
import sys
from pathlib import Path

from qcloud_cos import CosConfig, CosS3Client
from qcloud_cos.cos_exception import CosServiceError

BUCKET = 'ashub-release-1258678103'
MANIFESTS = ('latest.yml', 'latest-mac.yml', 'latest-linux.yml')
VERSION = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'
MAX_MANIFEST = 64 * 1024


def object_or_missing(call, key, *, head=False):
    try:
        return call(Bucket=BUCKET, Key=key)
    except CosServiceError as error:
        # Missing keys alone are safe. HEAD responses can have no error body.
        if str(error.get_status_code()) == '404':
            code = error.get_error_code()
            if code == 'NoSuchKey' or (head and not code):
                return None
        raise RuntimeError(f'Cannot check COS object {key!r}: HTTP {error.get_status_code()}') from error


def read_manifest(response):
    raw = response['Body'].get_raw_stream()
    try:
        data = raw.read(MAX_MANIFEST + 1)
    finally:
        raw.close()
    if len(data) > MAX_MANIFEST:
        raise RuntimeError('Existing COS manifest exceeds the preflight size limit')
    return data


def manifest_version(data, name):
    # electron-builder emits a single top-level version field. Refuse an
    # unreadable or unfamiliar manifest instead of guessing it is an older one.
    version_lines = re.findall(r'^version:[^\r\n]*', data.decode('utf-8-sig'), re.MULTILINE)
    pattern = rf"version:[ \t]*(['\"]?)({VERSION})\1[ \t]*"
    match = re.fullmatch(pattern, version_lines[0]) if len(version_lines) == 1 else None
    if not match:
        raise RuntimeError(f'Cannot determine the existing COS version in {name}')
    return match.group(2)


def sha256(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(chunk)
    return digest.digest()


def check(client, version, payloads, source=None):
    candidate = tuple(map(int, version.split('.')))
    matching = []
    for name in MANIFESTS:
        remote = object_or_missing(client.get_object, name)
        if remote is None:
            continue
        data = read_manifest(remote)
        latest = manifest_version(data, name)
        if tuple(map(int, latest.split('.'))) < candidate:
            continue
        if latest == version and source is not None and data == (source / name).read_bytes():
            matching.append(name)
            continue
        raise RuntimeError(f'COS {name} already advertises v{latest}; refusing to replace it with v{version}')
    for name in payloads:
        if source is None:
            if object_or_missing(client.head_object, name, head=True) is not None:
                raise RuntimeError(f'COS payload {name} already exists; refusing to overwrite it')
            continue
        remote = object_or_missing(client.get_object, name)
        if remote is None:
            continue
        raw = remote['Body'].get_raw_stream()
        try:
            with (source / name).open('rb') as local:
                if sha256(raw) != sha256(local):
                    raise RuntimeError(f'COS payload {name} differs from the GitHub release; refusing to overwrite it')
        finally:
            raw.close()
        matching.append(name)
    return matching


def main():
    mode, version, directory, *payloads = sys.argv[1:]
    if mode not in ('new', 'resume') or not re.fullmatch(VERSION, version) or not payloads:
        raise RuntimeError('Expected publication mode, release version, asset directory and payload names')
    client = CosS3Client(CosConfig(
        Region='ap-beijing', SecretId=os.environ['COS_SECRET_ID'],
        SecretKey=os.environ['COS_SECRET_KEY'],
        Endpoint='cos.accelerate.myqcloud.com',
    ))
    for name in check(client, version, payloads, Path(directory) if mode == 'resume' else None):
        print(name)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.exit(f'COS preflight failed: {error}. Use a new version for a rebuild; '
                 'resync only resumes the original bytes and cannot overwrite conflicts.')
