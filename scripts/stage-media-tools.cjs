const { accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const archNames = ['ia32', 'x64', 'armv7l', 'arm64'];

function stageMediaTools(context, projectRoot = join(__dirname, '..')) {
  const platform = context.electronPlatformName;
  const arch = archNames[context.arch];
  if (!['darwin', 'win32'].includes(platform) || !arch) throw new Error(`Unsupported release target: ${platform}-${context.arch}`);

  const resources = platform === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources');
  const target = join(resources, 'media-tools', `${platform}-${arch}`);

  for (const tool of ['ffmpeg', 'ffprobe']) {
    const executable = `${tool}${platform === 'win32' ? '.exe' : ''}`;
    const source = join(projectRoot, 'node_modules', `@${tool}-installer`, `${platform}-${arch}`, executable);
    let valid = false;
    try {
      const info = lstatSync(source);
      valid = info.isFile() && !info.isSymbolicLink();
      if (valid && platform !== 'win32') accessSync(source, constants.X_OK);
    } catch { valid = false; }
    if (!valid) throw new Error(`Missing release media tool: ${platform}-${arch}/${executable}`);
    mkdirSync(target, { recursive: true });
    const destination = join(target, executable);
    copyFileSync(source, destination);
    if (platform !== 'win32') chmodSync(destination, 0o755);
  }
}

module.exports = { default: stageMediaTools, stageMediaTools };
