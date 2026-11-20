export type SortOrder = 'default' | 'asc' | 'desc';

export interface Preferences {
  fontSize: number;
  theme: 'system' | 'light' | 'dark';
  up: string;
  down: string;
  title: string;
  icon: 'none' | 'activity' | 'candles' | 'png';
  png: string;
  gold: boolean;
  silver: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  fontSize: 8, theme: 'system', up: '', down: '', title: '', icon: 'none', png: '', gold: true, silver: true,
};

export const MAX_ICON_BYTES = 128 * 1024;

export function isPng(bytes: Uint8Array): boolean {
  const png = Buffer.from(bytes);
  if (png.length < 33 || png.length > MAX_ICON_BYTES || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(8) !== 13) return false;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width > 0 && width <= 512 && height > 0 && height <= 512;
}

export function preferences(raw: unknown): Preferences {
  const value = raw && typeof raw === 'object' ? raw as Partial<Preferences> : {};
  const color = (input: unknown) => typeof input === 'string' && /^#[0-9a-f]{6}$/i.test(input) ? input : '';
  const png = typeof value.png === 'string' && value.png.length <= Math.ceil(MAX_ICON_BYTES / 3) * 4 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value.png) && isPng(Buffer.from(value.png, 'base64')) ? value.png : '';
  return {
    fontSize: Number.isInteger(value.fontSize) && value.fontSize! >= 8 && value.fontSize! <= 20 ? value.fontSize! : 8,
    theme: value.theme === 'light' || value.theme === 'dark' ? value.theme : 'system',
    up: color(value.up), down: color(value.down),
    title: typeof value.title === 'string' ? value.title.replace(/[\r\n\t]/g, ' ').trim().slice(0, 40) : '',
    icon: value.icon === 'activity' || value.icon === 'candles' || (value.icon === 'png' && png) ? value.icon : 'none',
    png, gold: value.gold !== false, silver: value.silver !== false,
  };
}
