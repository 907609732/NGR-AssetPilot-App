# 浏览器端第三方依赖

## fflate 0.8.3

- 用途：在浏览器本地生成 ZIP 压缩包。
- 来源：npm 包 `fflate@0.8.3`，项目主页为 <https://101arrowz.github.io/fflate/>。
- 许可证：MIT，许可证文本见 `fflate-LICENSE.txt`。
- 安装命令：`npm pack fflate@0.8.3`，取包内 `umd/index.js` 固定保存为 `fflate-0.8.3.min.js`。
- 安全边界：只压缩用户已经上传到当前页面的图片，不会把图片上传到网络。
