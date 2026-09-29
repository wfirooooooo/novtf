# novtf

[中文](#中文)

A multi-cloud resource control plane. It is written in TypeScript and runs on Node.js 22. State is one SQLite file.

## Processes

One image. The argument selects the role:

- `api` listens on `127.0.0.1:8080`. The pages only read the database.
- `state` listens on 8081 for the Terraform HTTP backend. It is not published on the host.
- `supervisor` backs the database up to `/var/lib/novtf/backups` once a day. Queued work stays `queued` until a runner image is connected.
- `collector` marks expired runtime status as stale every 60 seconds. It does not call cloud APIs.

```sh
npm test
npm run typecheck
NOVTF_OPERATOR_PASSWORD=choose-one NOVTF_DATA_DIR=./data npm start
```

On the first start, if the database has no users, `NOVTF_OPERATOR_PASSWORD` creates `admin`. The page is `/login`. `state` also needs `NOVTF_MASTER_KEY` (64 hexadecimal characters) and `NOVTF_STATE_PASSWORD`.

Compose:

```sh
NOVTF_OPERATOR_PASSWORD=… NOVTF_MASTER_KEY=… NOVTF_STATE_PASSWORD=… docker compose up --build
```

## 中文

[English](#novtf)

多云服务资源管理系统。开发语言是 TypeScript，运行在 Node.js 22。数据库是一个 SQLite 文件。

### 进程

同一份镜像，用参数选择角色：

- `api` 只听 `127.0.0.1:8080`。页面只读数据库。
- `state` 听 8081，给 Terraform HTTP backend 用，不映射到宿主机。
- `supervisor` 每天把库备份到 `/var/lib/novtf/backups`。队列里的任务在 runner 镜像接入前保持 `queued`。
- `collector` 按 60 秒把过期的运行状态标成 stale。它不调用云 API。

```sh
npm test
npm run typecheck
NOVTF_OPERATOR_PASSWORD=choose-one NOVTF_DATA_DIR=./data npm start
```

第一次启动且库里没有用户时，用 `NOVTF_OPERATOR_PASSWORD` 创建 `admin`。页面在 `/login`。`state` 还需要 `NOVTF_MASTER_KEY`（64 位十六进制）和 `NOVTF_STATE_PASSWORD`。

Compose：

```sh
NOVTF_OPERATOR_PASSWORD=… NOVTF_MASTER_KEY=… NOVTF_STATE_PASSWORD=… docker compose up --build
```
