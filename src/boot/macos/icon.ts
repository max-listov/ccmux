import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

function runStrict(command: string[], label: string): string {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    const err = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`${label}: ${err || `exit ${result.exitCode}`}`);
  }
  return result.stdout.toString();
}

function findRsvgConvert(): string | null {
  for (const candidate of [
    Bun.which('rsvg-convert'),
    '/opt/homebrew/bin/rsvg-convert',
    '/usr/local/bin/rsvg-convert',
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Apple HIG macOS app icon SVG (824x824 squircle centered on a transparent 1024x1024 canvas). */
export function stitchmuxIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#D97441"/>
      <stop offset="100%" stop-color="#B84A27"/>
    </linearGradient>
    <linearGradient id="screen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1A1614"/>
      <stop offset="100%" stop-color="#0E0C0B"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.32"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)" filter="url(#shadow)"/>
  <rect x="184" y="196" width="656" height="292" rx="64" fill="#F4EDE4"/>
  <rect x="210" y="222" width="290" height="240" rx="42" fill="url(#screen)"/>
  <rect x="524" y="222" width="290" height="240" rx="42" fill="url(#screen)"/>
  <rect x="184" y="528" width="656" height="292" rx="64" fill="#F4EDE4"/>
  <rect x="210" y="554" width="290" height="240" rx="42" fill="url(#screen)"/>
  <rect x="524" y="554" width="290" height="240" rx="42" fill="url(#screen)"/>
  <g fill="none" stroke="#F4EDE4" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="232,342 308,342 338,266 368,418 398,342 478,342"/>
    <polyline points="546,342 622,342 652,266 682,418 712,342 792,342"/>
    <polyline points="232,674 308,674 338,598 368,750 398,674 478,674"/>
    <polyline points="546,674 622,674 652,598 682,750 712,674 792,674"/>
  </g>
</svg>`;
}

/** Pure-JS fallback PNG renderer when `rsvg-convert` is absent on a macOS host. */
function renderFallbackIconPng(size: number): Buffer {
  const png = new PNG({ width: size, height: size });
  const pad = size * (100 / 1024);
  const inner = size - pad * 2;
  const radius = inner * (185 / 824);

  const inRoundedRect = (
    x: number,
    y: number,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    r: number,
  ): boolean => {
    if (x < rx || x >= rx + rw || y < ry || y >= ry + rh) return false;
    const cx = Math.max(rx + r, Math.min(x, rx + rw - r));
    const cy = Math.max(ry + r, Math.min(y, ry + rh - r));
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };

  const scale = size / 1024;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      if (!inRoundedRect(x, y, pad, pad, inner, inner, radius)) {
        png.data[idx + 3] = 0;
        continue;
      }
      let r = 204;
      let g = 94;
      let b = 50;
      const inFrame =
        inRoundedRect(x, y, 184 * scale, 196 * scale, 656 * scale, 292 * scale, 64 * scale) ||
        inRoundedRect(x, y, 184 * scale, 528 * scale, 656 * scale, 292 * scale, 64 * scale);
      if (inFrame) {
        r = 244;
        g = 237;
        b = 228;
      }
      const inScreen =
        inRoundedRect(x, y, 210 * scale, 222 * scale, 290 * scale, 240 * scale, 42 * scale) ||
        inRoundedRect(x, y, 524 * scale, 222 * scale, 290 * scale, 240 * scale, 42 * scale) ||
        inRoundedRect(x, y, 210 * scale, 554 * scale, 290 * scale, 240 * scale, 42 * scale) ||
        inRoundedRect(x, y, 524 * scale, 554 * scale, 290 * scale, 240 * scale, 42 * scale);
      if (inScreen) {
        r = 20;
        g = 17;
        b = 15;
        const localY = y / scale;
        if (Math.abs(localY - 342) < 14 || Math.abs(localY - 674) < 14) {
          r = 244;
          g = 237;
          b = 228;
        }
      }
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Build `AppIcon.icns` inside `resourcesDir` using `rsvg-convert` (or `pngjs`+`sips`) and `iconutil`. */
export function buildMacosIcns(resourcesDir: string): void {
  const work = mkdtempSync(join(tmpdir(), 'stitchmux-icon-'));
  try {
    const iconset = join(work, 'AppIcon.iconset');
    mkdirSync(iconset);
    const rsvg = findRsvgConvert();
    const svgPath = join(work, 'AppIcon.svg');
    const masterPng = join(work, 'AppIcon-1024.png');
    if (rsvg !== null) {
      writeFileSync(svgPath, stitchmuxIconSvg());
    } else {
      writeFileSync(masterPng, renderFallbackIconPng(1024));
    }
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const px = String(size * scale);
        const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
        const out = join(iconset, name);
        if (rsvg !== null) {
          runStrict([rsvg, '-w', px, '-h', px, svgPath, '-o', out], 'rsvg-convert');
        } else {
          runStrict(['sips', '-z', px, px, masterPng, '--out', out], 'sips');
        }
      }
    }
    mkdirSync(resourcesDir, { recursive: true });
    runStrict(
      ['iconutil', '-c', 'icns', iconset, '-o', join(resourcesDir, 'AppIcon.icns')],
      'iconutil',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
