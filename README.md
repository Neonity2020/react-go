# React Go

React + TypeScript + Vite 围棋 Web UI，支持双人对弈、人机对弈、猜先、手顺记录、形势估算和 KataGo 本地引擎接入。

## 开发

```sh
npm run dev
```

## 桌面应用（Tauri 2）

开发模式一键启动桌面壳、前端和内置 KataGo bridge：

```sh
npm run tauri:dev
```

打包安装包：

```sh
npm run tauri:build
```

Tauri 版本会在应用启动时自动监听 `http://127.0.0.1:3107`，前端仍使用相同的 `/move`、`/analyze` 和 `/health` 接口。打包后的应用不需要用户单独运行 `npm run bridge`。

## KataGo Bridge

Web 开发模式下，KataGo 通过本地 Node bridge 提供给浏览器使用：

```sh
npm run bridge
```

默认读取 Homebrew 安装路径：

- Binary: `/opt/homebrew/bin/katago`
- Model: `/opt/homebrew/opt/katago/share/katago/kata1-b18c384nbt-s9996604416-d4316597426.bin.gz`
- Config: `/opt/homebrew/opt/katago/share/katago/configs/gtp_example.cfg`

可以用环境变量覆盖：

```sh
KATAGO_MODEL=/path/to/model.bin.gz KATAGO_CONFIG=/path/to/gtp.cfg npm run bridge
```

桌面应用同样支持 `KATAGO_BIN`、`KATAGO_MODEL`、`KATAGO_CONFIG`、`KATAGO_BRIDGE_PORT` 和 `KATAGO_LOG_DIR` 环境变量。

如果 bridge 没有运行，人机模式会自动回退到浏览器内置 AI。
