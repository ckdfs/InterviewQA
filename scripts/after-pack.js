/**
 * macOS 打包后处理：在未配置开发者证书时对 .app 做 ad-hoc 签名。
 *
 * 为什么必须有这一步：
 *   electron-builder 把 Info.plist 的 CFBundleIdentifier、权限描述等改完之后，
 *   Electron 自带的签名就失效了。identity 为 null 时 electron-builder 会跳过签名，
 *   于是分发包落在用户机器上（带 quarantine 属性）会被 Gatekeeper 判为「已损坏」，
 *   在 Apple Silicon 上直接无法启动；屏幕录制权限也无法稳定授予。
 *   ad-hoc 签名（codesign --sign -）不依赖任何证书，足以让应用正常启动并被授权。
 *
 * 挂在 afterPack 而不是 afterSign：identity 为 null 时 electron-builder 认为
 * 「没有发生签名」，会直接跳过 afterSign 钩子，钩子根本不会执行。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 是否已经配置了真实的开发者证书（交给 electron-builder 自己签名，不再干预） */
function hasDeveloperCertificate() {
  return Boolean(process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_KEY_PASSWORD);
}

function adhocSign(appPath) {
  console.log(`[签名] 未配置开发者证书，对 ${path.basename(appPath)} 执行 ad-hoc 签名`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' });
  console.log('[签名] ad-hoc 签名校验通过');
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (hasDeveloperCertificate()) {
    console.log('[签名] 检测到开发者证书配置，跳过 ad-hoc 签名');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  if (!fs.existsSync(appPath)) {
    console.warn(`[签名] 未找到 ${appPath}，跳过`);
    return;
  }
  adhocSign(appPath);
};
