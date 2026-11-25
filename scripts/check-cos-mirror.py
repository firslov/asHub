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


def check_error(key, error):
    return RuntimeError(f'Cannot check COS object {key!r}: HTTP {error.get_status_code()}')


def object_or_missing(call, key, **kwargs):
    try:
        return call(Bucket=BUCKET, Key=key, **kwargs)
    except CosServiceError as error:
        if str(error.get_status_code()) == '404' and error.get_error_code() == 'NoSuchKey':
            return None
        raise check_error(key, error) from error


def payload_exists(client, key):
    try:
        client.head_object(Bucket=BUCKET, Key=key)
        return True
    except CosServiceError as error:
        if str(error.get_status_code()) != '404':
            raise check_error(key, error) from error
        # The Tencent SDK synthesizes NoSuchResource for HEAD 404, without
        # distinguishing an absent key from a wrong bucket or endpoint. Ask
        # GET for the explicit error, without downloading a potentially large file.
        code = error.get_error_code()
        if code == 'NoSuchKey':
            return False
        if code not in ('NoSuchResource', 'Unknown', '', None):
            raise check_error(key, error) from error
    response = object_or_missing(client.get_object, key, Range='bytes=0-0')
    if response is None:
        return False
    response['Body'].get_raw_stream().close()
    return True


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
            if payload_exists(client, name):
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
