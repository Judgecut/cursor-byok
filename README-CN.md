<div align="center">

# cursor-byok

在 Cursor 中使用你自己的模型 API，个人魔改版。

[下载](https://github.com/Judgecut/cursor-byok/releases) · [上游仓库](https://github.com/leehainuo/cursor-byok) · [原始项目](https://github.com/leookun/cursor-byok) · [English](./README.md)

[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
![Platforms](https://img.shields.io/badge/platform-Windows%20tested-lightgrey?style=flat-square)
![Status](https://img.shields.io/badge/status-personal%20fork-orange?style=flat-square)

</div>

![将 cursor-byok 连接到多种模型 API](./images/en-brand-1.png)

![cursor-byok 控制面板](./images/en-home-1.png)

## 关于这个仓库

这是 [leehainuo/cursor-byok](https://github.com/leehainuo/cursor-byok) 的个人 fork，而它又源自 [leookun/cursor-byok](https://github.com/leookun/cursor-byok)。

Cursor 客户端协议一直在变。上游版本跟着协议调整时，本地这份经常就直接用不了了；与其等上游修，我干脆在自己这份 fork 里改协议适配，先保证手上的环境能跑。

## 当前状态

| 项目 | 说明 |
| --- | --- |
| 维护方式 | 个人单飞，不再跟随上游节奏，也不承诺合并上游改动 |
| 平台 | 只有 Windows，也只在 Windows 上测试 |
| 发布 | 以 Windows 安装包（NSIS）为主，自己装着方便；暂时还没发，可以先从源码构建，之后会陆续放出来 |
| 后续 | 可能会陆续补一些自己使用习惯相关的功能，不成体系，也不保证通用 |

## 与上游的差异

- **Cursor 协议适配由本仓库自行维护。** 上游实现跑不起来时，这里会直接按 Cursor 当前协议改；改完可能又和上游对不上。
- **功能上会慢慢偏个人化。** 后续加的多是自己用着顺手的东西，不追求覆盖通用需求。

除此之外，产品本身的能力仍是上游那一套：在本机做协议适配、模型请求转发、工具调用协调和会话状态，继续使用工具调用、Skills、MCP 和多轮对话。

## 工作原理

```text
Cursor 客户端
    │
    │ Agent 请求与工具结果
    ▼
cursor-byok 本地服务
    │
    │ OpenAI / Anthropic 兼容请求
    ▼
你配置的模型 API
```

API Key 与应用设置保存在本地；模型请求仍会发送到你配置的服务商。

## 构建与运行

前置：Rust stable、Node.js 22 或更新版本，以及 [Tauri 2 的 Windows 前置条件](https://v2.tauri.app/start/prerequisites/)（MSVC 生成工具、WebView2）。

```powershell
npm --prefix apps/desktop ci
npm --prefix apps/desktop run tauri:dev
```

打包 NSIS 安装包：

```powershell
npm --prefix apps/desktop run tauri:build -- --bundles nsis
```

产物在 `apps/desktop/src-tauri/target/release/bundle/nsis/`。安装了 `make` 的话，`make dev-desktop` 和 `make build-desktop` 是同样的两件事。

不想自己编译的，等装好的包放到 [Releases](https://github.com/Judgecut/cursor-byok/releases) 再下也行，目前还是空的。

## 需要注意

- 只有 Windows 经过测试，macOS 和 Linux 没验证过。
- Cursor 再次改动协议时，可能要我自己跟进；这段时间里可能出现无法使用的情况。
- 与上游的差异会越来越大，出问题时按上游的文档和 Issue 排查不一定对得上。

## 致谢

感谢 [leookun](https://github.com/leookun/cursor-byok) 写下的原始项目，感谢 [leehainuo](https://github.com/leehainuo/cursor-byok) 维护的上游版本，也感谢社区里所有贡献代码、提交反馈的人。没有这些工作，这份 fork 无从谈起。

项目采用 [MIT License](./LICENSE)。原作者版权声明和完整许可文本见[第三方许可](./THIRD-PARTY-LICENSES.md)。

对这份魔改版感兴趣的话，按自己的喜好拿去改、拿去用就行，遵循 MIT 即可。
