"""Read individual members of a remote zip via HTTP range requests (no full download).

    python remote_zip.py list <url> [pattern]
    python remote_zip.py get <url> <out_dir> <regex>
"""
import io
import re
import sys
import urllib.request
import zipfile
from pathlib import Path


class HttpRangeFile(io.RawIOBase):
    def __init__(self, url):
        self.src = url
        self._resolve()
        self.pos = 0
        self.fetched = 0

    def _resolve(self):
        """Follow the redirect to the signed storage URL (these expire, so re-run on 403)."""
        req = urllib.request.Request(self.src, method='HEAD')
        with urllib.request.urlopen(req) as r:
            self.url = r.geturl()
            self.size = int(r.headers['Content-Length'])
            assert r.headers.get('Accept-Ranges', 'bytes') == 'bytes'

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = {0: offset, 1: self.pos + offset, 2: self.size + offset}[whence]
        return self.pos

    def read(self, n=-1):
        if n < 0:
            n = self.size - self.pos
        if n == 0 or self.pos >= self.size:
            return b''
        end = min(self.pos + n, self.size) - 1
        for attempt in range(3):
            req = urllib.request.Request(self.url, headers={'Range': f'bytes={self.pos}-{end}'})
            try:
                with urllib.request.urlopen(req) as r:
                    data = r.read()
                break
            except urllib.error.HTTPError as e:
                if e.code != 403 or attempt == 2:
                    raise
                self._resolve()
        self.pos += len(data)
        self.fetched += len(data)
        return data

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)


if __name__ == '__main__':
    cmd, url = sys.argv[1], sys.argv[2]
    f = HttpRangeFile(url)
    z = zipfile.ZipFile(io.BufferedReader(f, buffer_size=1 << 16))
    if cmd == 'list':
        pat = re.compile(sys.argv[3] if len(sys.argv) > 3 else '.')
        names = [i for i in z.infolist() if pat.search(i.filename)]
        for i in names[:60]:
            print(f'{i.file_size:>10}  {i.filename}')
        print(f'{len(names)} matching of {len(z.infolist())} members; archive {f.size / 1e6:.0f} MB; fetched {f.fetched / 1e6:.2f} MB')
    else:
        out = Path(sys.argv[3])
        out.mkdir(parents=True, exist_ok=True)
        pat = re.compile(sys.argv[4])
        n = 0
        for i in z.infolist():
            if pat.search(i.filename):
                (out / Path(i.filename).name).write_bytes(z.read(i))
                n += 1
        print(f'extracted {n} files; fetched {f.fetched / 1e6:.2f} MB of {f.size / 1e6:.0f} MB')
