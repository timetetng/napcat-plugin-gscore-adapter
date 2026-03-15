import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function getBundledIconPath(): string | null {
    try {
        const currentFile = fileURLToPath(import.meta.url);
        const currentDir = path.dirname(currentFile);
        return path.join(currentDir, 'icon.png');
    } catch {
        return null;
    }
}

export async function ensureConfigIcon(
    configPath: string,
    logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void; debug?: (...args: any[]) => void }
): Promise<void> {
    const configDir = path.dirname(configPath);
    const targetPath = path.join(configDir, 'icon.png');

    if (fs.existsSync(targetPath)) return;

    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    const bundledIconPath = getBundledIconPath();
    if (bundledIconPath && fs.existsSync(bundledIconPath)) {
        fs.copyFileSync(bundledIconPath, targetPath);
        logger?.info?.('[icon-cache] 已将内置 icon.png 写入配置目录');
        return;
    }

    logger?.warn?.('[icon-cache] 未找到内置 icon.png，已跳过写入');
}
