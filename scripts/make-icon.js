/**
 * 生成应用图标 build/icon.png（1024×1024）。
 *
 * 用 Electron 自身离屏渲染一张矢量稿再截图，不引入任何图形库依赖。
 * electron-builder 会自动把它转换成 macOS 的 .icns 与 Windows 的 .ico，
 * 因此仓库里只需要保留这一个 PNG。
 *
 * 用法：npm run icon
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

const PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; }
  .icon {
    width: ${SIZE}px; height: ${SIZE}px;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(145deg, #4f83ff 0%, #2f6bff 52%, #1f4fd0 100%);
    border-radius: 226px;
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }
  .glyph {
    font-size: 430px; font-weight: 600; color: #fff; line-height: 1;
    margin-top: -150px;
    text-shadow: 0 16px 36px rgba(10, 28, 80, 0.26);
  }
  .bar {
    position: absolute; left: 50%; bottom: 172px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 24px;
  }
  .bar i {
    display: block; width: 30px; border-radius: 15px; background: rgba(255, 255, 255, 0.92);
  }
</style></head>
<body>
  <div class="icon">
    <span class="glyph">面</span>
    <div class="bar">
      <i style="height:44px"></i><i style="height:80px"></i><i style="height:58px"></i>
      <i style="height:104px"></i><i style="height:50px"></i>
    </div>
  </div>
</body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  await new Promise((resolve) => setTimeout(resolve, 600));

  const image = await win.webContents.capturePage();
  const resized = image.getSize().width === SIZE ? image : image.resize({ width: SIZE, height: SIZE, quality: 'best' });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, resized.toPNG());

  const { width, height } = resized.getSize();
  console.log(`已生成图标：${OUT}（${width}×${height}，${(fs.statSync(OUT).size / 1024).toFixed(1)} KB）`);
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
