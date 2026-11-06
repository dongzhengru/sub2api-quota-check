# Sub2API 额度面板

Python FastAPI 后端 + 无需构建的响应式前端，展示 5 小时、7 天额度的已使用比例、剩余比例、下次重置时间和倒计时。

## 用户 Token 用量

额度页面下方展示按总 Token 降序排列的用户用量，包含请求数、输入、输出、缓存和总 Token，以及费用（`cost`，以 $ 显示）。Token 自动换算为 K、M，悬停显示完整数值；费用四舍五入后固定显示 3 位小数，悬停显示完整数值。支持 1 天（今天）、3 天、7 天快捷选择及自定义日期，包含首尾日期，按 `SUB2API_TIMEZONE` 计算。支持每页 20、50、100 条，切换查询范围或每页条数会回到第一页。

后端接口：`GET /api/user-breakdown?start_date=2026-11-01&end_date=2026-11-06&page=1&page_size=20`，复用后端管理员登录，遇到 401 重登一次。统计按需查询，不使用额度卡片缓存。上游示例只有排名 `limit`，因此翻页按所需数量扩大 `limit`，多取一条判断是否还有下一页，不提供未经上游确认的总人数。此分页方式要求上游遵守请求的 `limit`；如果上游另有数量上限，需要按其实际分页协议调整。

## Codex 常驻额度侧栏

已加入无需聊天触发的 macOS CDP 侧栏组件及原生菜单栏助手。安装后的 **Codex 额度助手.app** 提供启动客户端、停止额度、查看状态和卸载入口；不会添加开机登录项，也不会自动打开 ChatGPT。它直接查询部署后的额度接口，无需启动本项目后端。源码运行仍可使用根目录 `.command` 文件。详见 [侧栏使用说明](codex-sidebar/README.md)。

## 运行

需要 Python 3.9 或更新版本。

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env，填写登录账号和密码
uvicorn app:app --host 127.0.0.1 --port 8000 --workers 1
```

打开 http://127.0.0.1:8000 。接口：`GET /api/usage`；接口文档：`/docs`。

使用 uv 时，也可以执行 `uv venv`、`uv pip install -r requirements.txt`，然后运行 `.venv/bin/uvicorn app:app --port 8000 --workers 1`。

## Docker 运行

先准备好 `.env` 配置文件，然后构建并启动：

```sh
docker build -t sub2api-usage .
docker run -d --name sub2api-usage \
  --restart unless-stopped \
  --env-file .env \
  -p 127.0.0.1:8000:8000 \
  sub2api-usage
```

打开 http://127.0.0.1:8000 。查看日志：`docker logs -f sub2api-usage`。

镜像使用 Python 3.12，以非 root 用户启动单个 worker，保留一分钟共享缓存语义。`.env` 不会进入构建上下文或镜像，配置在启动时注入。健康检查只访问本地页面，不触发上游额度查询。

如果额度查询返回 `423 / ADMIN_COMPLIANCE_ACK_REQUIRED`，说明上游要求完成管理员合规确认。请使用配置的查询账号登录 Sub2API 管理后台，完成合规确认，再刷新额度页面。后端会明确显示这个原因，不会自动替账号完成确认。修改代码后，Docker 部署需要重新构建镜像并重建容器。

## 配置

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| SUB2API_BASE_URL | Sub2API 地址 | https://gateway.zhengru.top |
| SUB2API_EMAIL | 登录邮箱 | 无 |
| SUB2API_PASSWORD | 登录密码 | 无 |
| SUB2API_ACCOUNT_ID | 被查询账号 ID | 1 |
| SUB2API_TIMEZONE | 上游和页面使用的时区 | Asia/Shanghai |

示例中的登录返回 `role=user`，查询示例却使用管理员令牌。`/api/v1/admin/accounts/1/usage` 通常需要管理员权限；如果返回 403，请配置具有该接口访问权限的账号。前端会展示明确的权限错误。页面查询的是配置的固定账号，不是访问者各自的账号。

令牌仅保存在后端内存，自动登录、到期前重新登录；遇到 HTTP 401 重新登录并重试一次。密码和令牌不发送到浏览器、不写日志；请勿提交 `.env`。

## 缓存语义

首次请求登录并向上游查询（`source=active&force=true&timezone=Asia/Shanghai`）。成功返回后缓存 60 秒，期间所有请求共享缓存，点击刷新也遵守缓存。使用异步锁合并同时到达的成功查询，避免并发击穿。缓存到期后由下一个请求查询上游，没有后台主动查询。页面每 60 秒请求一次。

缓存只保存成功结果，失败返回明确错误，不把过期额度冒充最新数据。页面更新失败时保留上次展示数据并标记更新失败。缓存为单进程内存缓存，因此运行时使用 **一个 worker**；多进程或多实例共享缓存需接入 Redis。服务当前面向本机使用，若公开部署，请在反向代理添加访问控制。

响应中的 `cache.hit` 表示是否命中缓存；`cache.remaining_seconds` 是剩余缓存时间，`cache.fetched_at` 是真实查询完成时间。

## 测试

```sh
.venv/bin/python -m pytest -q
```

测试使用模拟上游，不依赖真实账号，不触发真实登录。
