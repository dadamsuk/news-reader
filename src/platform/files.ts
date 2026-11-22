import { Directory, File, Paths } from 'expo-file-system';
import type { Files } from '../reader/body';

const root = () => new Directory(Paths.document, 'articles');

export function articleDir(articleId: number): Directory {
  return new Directory(root(), String(articleId));
}

function ensureDir(dir: Directory): void {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
}

function extOf(url: string): string {
  const m = /\.(jpe?g|png|webp|gif|avif)(?:[?#.]|$)/i.exec(url);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

/** Offline copies of article images, one folder per article under the app's documents directory. */
export const files: Files = {
  async saveImage(articleId, url, index) {
    try {
      const dir = articleDir(articleId);
      ensureDir(dir);
      const dest = new File(dir, `${index}.${extOf(url)}`);
      if (dest.exists) return dest.uri;
      const out = await File.downloadFileAsync(url, dest);
      return out.uri;
    } catch {
      return null;
    }
  },
  async removeArticles(ids) {
    for (const id of ids) {
      try {
        const dir = articleDir(id);
        if (dir.exists) dir.delete();
      } catch {
        // already gone
      }
    }
  },
};

/** Writes the reader page next to its images so the WebView can load both from disk. */
export function writeReaderPage(articleId: number, html: string): string {
  const dir = articleDir(articleId);
  ensureDir(dir);
  const file = new File(dir, 'index.html');
  if (!file.exists) file.create();
  file.write(html);
  return file.uri;
}

export function articleDirUri(articleId: number): string {
  return articleDir(articleId).uri;
}
