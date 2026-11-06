# 渲染界面第三方依赖

本目录由 Electron 桌面界面及历史浏览器兼容模式共用，使用说明见 [桌面版教程](../../docs/NGRAI辅助UI切图命名工具-使用教程脚本与图文教程.md)。

## fflate 0.8.3

- 用途：在本机的桌面渲染界面或浏览器兼容页面生成 ZIP 压缩包。
- 来源：npm 包 `fflate@0.8.3`，项目主页为 <https://101arrowz.github.io/fflate/>。
- 许可证：MIT，许可证文本见 `fflate-LICENSE.txt`。
- 安装命令：`npm pack fflate@0.8.3`，取包内 `umd/index.js` 固定保存为 `fflate-0.8.3.min.js`。
- 安全边界：只压缩用户已经上传到当前页面的图片，不会把图片上传到网络。
