# 第三方组件与许可声明

ImageHunter 本体以 **AGPL-3.0-only** 发布（见 `LICENSE`）。下面这些是随扩展一起分发的
第三方作品，各自的许可与版权声明如下。它们在**运行时**随扩展分发，因此必须保留声明
（开发期依赖不进扩展包，不在本表内 —— 见 `tools/package.js` 的白名单）。

---

## Lucide 图标

- 用途：`shared/lucide.js` 里 29 个图标的路径数据，以及 `popup/popup.html` /
  `options/options.html` 中内联的静态副本
- 版本：`lucide-static@1.61.0`
- 上游：https://lucide.dev · https://github.com/lucide-icons/lucide
- 许可：**ISC**（其中 11 个图标源自 Feather，那部分是 **MIT**）

### ISC License

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### Feather 派生部分（MIT）

本项目实际用到的、源自 Feather 的图标共 11 个：

```
search, chevrons-down, x, check, zoom-in, download,
chevron-left, chevron-right, chevron-down, link, external-link
```

```
The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 说明

- 本文件与 `LICENSE` 一起**打进扩展包**（`tools/package.js` 的 `ROOT_FILES`），
  所以下载 zip 的人手里也有完整声明 —— 声明只留在仓库里是不够的，
  分发物本身必须带着它。`tests/test-package.js` 断言这两份文件在包里。
- 图标**没有**改动形状，路径数据与上游 SVG 的 `<svg>` 内部内容逐字符一致
  （`validate.js` 第 21 节会逐形状对拍，见 `HANDBOOK.md` 的 v1.19.0 条目）。
- 扩展本体**零依赖零构建**，除上述图标数据外不打包任何第三方代码。
- 若后续新增第三方资源，请在此追加一节，并在 `shared/lucide.js` 之类的源文件头
  标注许可 —— 只在 README 提一句是不够的。
