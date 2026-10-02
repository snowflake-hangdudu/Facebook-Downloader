"""Generate X Downloader icons from icons/icon-source.png."""
from pathlib import Path
import runpy

runpy.run_path(str(Path(__file__).with_name("gen_kit_icons.py")), run_name="__main__")
