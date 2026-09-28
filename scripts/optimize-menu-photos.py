"""Resize original menu photos to WebP without cropping or upscaling.

Requires Pillow. Examples:
  python scripts/optimize-menu-photos.py --manifest /path/to/manifest.json --allow-current
  python scripts/optimize-menu-photos.py --download-missing

Browser asset manifests contain {"assets": [{"url": "...", "path": "..."}]}.
The default is to require a local original in a manifest. --download-missing uses
the exact URLs recorded in docs/menu-photo-sources.json. --allow-current permits
existing site images as a fallback and keeps their original recorded source URL.
The script updates only public/data/menu.json and docs/menu-photo-sources.json;
it never changes a live .data/menu.json store or removes source files.
"""

import argparse
import io
import json
from pathlib import Path
from urllib.request import Request, urlopen

from PIL import Image, ImageOps


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def source_key(url):
    return url.rsplit("/", 1)[0]


def optimize(root, manifests, download_missing=False, allow_current=False):
    sources_path = root / "docs/menu-photo-sources.json"
    seed_path = root / "public/data/menu.json"
    sources = read_json(sources_path)
    seed = read_json(seed_path)
    image_dir = (root / "public/menu-images").resolve()
    image_dir.mkdir(parents=True, exist_ok=True)
    originals = {}
    for manifest in manifests:
        for asset in read_json(manifest).get("assets", []):
            if asset.get("url") and asset.get("path"):
                originals[source_key(asset["url"])] = asset

    report = []
    updated_paths = {}
    for photo in sources["photos"]:
        old_path = (root / "public" / photo["image"]).resolve()
        output_path = (image_dir / f"{photo['id']}.webp").resolve()
        if output_path.parent != image_dir or old_path.parent != image_dir:
            raise ValueError("Photo paths must stay directly inside public/menu-images")

        asset = originals.get(source_key(photo["url"]))
        used_url = photo["url"]
        if asset:
            source_bytes = Path(asset["path"]).read_bytes()
            used_url = asset["url"]
        elif download_missing:
            if not used_url.startswith("https://avatars.mds.yandex.net/get-sprav-products/"):
                raise ValueError("Unexpected photo source host")
            request = Request(used_url, headers={"User-Agent": "VosemUtraMenuPhotoOptimizer/1.0"})
            with urlopen(request, timeout=30) as response:
                source_bytes = response.read(25 * 1024 * 1024 + 1)
            if len(source_bytes) > 25 * 1024 * 1024:
                raise ValueError("Source photograph is larger than 25 MB")
        elif allow_current:
            source_bytes = old_path.read_bytes()
        else:
            raise ValueError(f"No local original for {photo['id']}; pass a manifest or --download-missing")

        with Image.open(io.BytesIO(source_bytes)) as source:
            image = ImageOps.exif_transpose(source)
            before = image.size
            image.thumbnail((960, 960), Image.Resampling.LANCZOS)
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA" if "transparency" in image.info else "RGB")
            options = {"format": "WEBP", "quality": 85, "method": 6}
            if source.info.get("icc_profile"):
                options["icc_profile"] = source.info["icc_profile"]
            temporary_path = output_path.with_suffix(".webp.tmp")
            image.save(temporary_path, **options)
            with Image.open(temporary_path) as result:
                result.verify()
            temporary_path.replace(output_path)
            dimensions = image.size

        photo["image"] = f"menu-images/{photo['id']}.webp"
        photo["url"] = used_url
        photo["width"], photo["height"] = dimensions
        photo["bytes"] = output_path.stat().st_size
        updated_paths[photo["id"]] = photo["image"]
        report.append({"id": photo["id"], "sourceBytes": len(source_bytes),
                       "bytes": photo["bytes"], "sourceSize": before,
                       "size": dimensions, "url": used_url})

    for item in seed["items"]:
        if item["id"] in updated_paths:
            item["image"] = updated_paths[item["id"]]
    sources["optimization"] = {"format": "WebP", "quality": 85,
                               "maxWidth": 960, "maxHeight": 960, "upscale": False,
                               "note": "Фотографии уменьшены пропорционально, без кадрирования и изменения содержания."}
    write_json(sources_path, sources)
    write_json(seed_path, seed)
    print(json.dumps({"photos": report, "totalSourceBytes": sum(row["sourceBytes"] for row in report),
                      "totalBytes": sum(row["bytes"] for row in report)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", action="append", type=Path, default=[])
    parser.add_argument("--download-missing", action="store_true")
    parser.add_argument("--allow-current", action="store_true")
    args = parser.parse_args()
    optimize(Path(__file__).resolve().parents[1], args.manifest, args.download_missing, args.allow_current)
