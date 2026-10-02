"""Build the Chromium (Chrome / Edge) release ZIP from runtime files only."""
from pack_common import ROOT, package_release


if __name__ == "__main__":
    package_release("manifest.json", f"{ROOT.name}.zip")
