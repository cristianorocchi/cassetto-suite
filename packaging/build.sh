#!/usr/bin/env bash
# Builds the desktop app into dist/cassetto/ and packs it as dist/cassetto-<version>-linux-x86_64.tar.gz.
# Needs uv (https://docs.astral.sh/uv/). Everything else it installs into a build environment of its own.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(sed -n 's/^__version__ = "\(.*\)"/\1/p' src/cassetto/__init__.py)
ENV=.build-env
uv venv -q --allow-existing -p "${PYTHON:-3.12}" "$ENV"
VIRTUAL_ENV="$ENV" uv pip install -q -e ".[desktop]" "pyinstaller>=6.6"
"$ENV/bin/pyinstaller" --noconfirm --clean --distpath dist --workpath build packaging/cassetto.spec
"$ENV/bin/python" packaging/trim_qt.py dist/cassetto/_internal
cp packaging/install.sh packaging/cassetto.desktop web/shell/icon.svg dist/cassetto/
chmod +x dist/cassetto/install.sh
NAME="cassetto-$VERSION-linux-$(uname -m)"
tar -C dist -czf "dist/$NAME.tar.gz" cassetto
echo "Built dist/cassetto/ and dist/$NAME.tar.gz"
