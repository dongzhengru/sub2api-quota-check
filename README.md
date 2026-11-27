# Sub2API 额度面板

Python FastAPI 后端 + 无需构建的响应式前端，展示 5 小时、7 天额度的已使用比例、剩余比例、下次重置时间和倒计时。Pro 账号没有 5 小时窗口：上游缺失或字段异常时 `/api/usage` 的 `five_hour` 返回 `null`，额度卡片自动隐藏并由 7 天卡片独占一行，侧栏折叠态的额度图案也换成整圆。`SUB2API_SHOW_FIVE_HOUR=false` 可随时关掉 5 小时窗口，效果与 Pro 账号一致。

## 重置卡到期时间

额度区域展示当前 `SUB2API_ACCOUNT_ID` 的 Claude 重置卡，包含当前可用次数、每张卡剩余次数、到期时间和剩余天数，3 天内到期或已到期时显示提醒。多张卡按到期时间排序；未返回到期时间时明确标注。Codex 侧栏额度详情也显示摘要，可展开查看所有卡片（北京时间）。

后端使用只读 `GET /api/v1/admin/accounts/{id}/claude/reset-credits`，不会兑换或消耗重置卡。`GET /api/usage` 新增 `reset_credits`，与额度共享 60 秒缓存；此查询失败会单独返回错误，不影响原有额度展示。需要上游版本支持此接口且查询账号有相应权限，目前接入的是 Claude 重置卡；账号有效期和充值码/订阅套餐期限属于其他信息。本地完成更新后还需更新服务端及侧栏程序。

## 用户 Token 用量

额度页面下方展示按实际费用降序排列的用户用量，包含请求数、输入、输出、缓存和总 Token、缓存命中率（缓存 / (输入 + 缓存)，保留 1 位小数），以及费用（`actual_cost`，以 $ 显示）。Token 自动换算为 K、M，悬停显示完整数值；费用四舍五入后固定显示 3 位小数，悬停显示完整数值。支持 1 天（今天）、3 天、7 天快捷选择及自定义日期，包含首尾日期，按 `SUB2API_TIMEZONE` 计算。支持每页 20、50、100 条，切换查询范围或每页条数会回到第一页。

额度卡片展示 Sub2API 上游 `window_stats` 的本周期请求数、Token、账号标准成本（`A $`）和用户实际费用（`U $`）。

在 Codex 侧栏点击「查看用量」，勾选「成本估算」即可查看满额费用预估和「账号直登（估算）」排行。开关默认关闭，选择保存在客户端。后端使用 SQLite 快照，从 7 天额度、点数余额和同期 Sub2API 账号成本的变化反推直登费用。估算取决于美元换算基准和快照覆盖范围，可通过 `SUB2API_SEVEN_DAY_COST_EQUIVALENT` 手动设置基准。网页版始终只显示上游用量。

后端接口：`GET /api/user-breakdown?start_date=2026-11-01&end_date=2026-11-06&page=1&page_size=20`，复用后端管理员登录，遇到 401 重登一次。统计按需查询，不使用额度卡片缓存。上游示例只有排名 `limit`，因此翻页按所需数量扩大 `limit`，多取一条判断是否还有下一页，不提供未经上游确认的总人数。此分页方式要求上游遵守请求的 `limit`；如果上游另有数量上限，需要按其实际分页协议调整。

## Codex 常驻额度侧栏

支持 Windows 和 macOS 的本机 CDP 侧栏，直接查询已部署的额度接口，无需启动本项目后端。卡片默认跟随系统深浅色，macOS 菜单栏助手的 **外观** 可固定浅色或深色。Windows 双击根目录 **启动额度侧栏.cmd**，自动识别 Microsoft Store 版或常见安装位置的 Codex / ChatGPT；停止和检查分别使用 **停止额度侧栏.cmd**、**查看额度状态.cmd**。需要 Node.js 22+；首次启动前先完全退出客户端。macOS 仍可使用原生菜单栏助手或 `.command` 启动器。详见 [侧栏使用说明](codex-sidebar/README.md)。

## 运行

macOS 菜单栏助手支持启动后及每小时自动检查远端、拉取代码、编译和安装更新，也可在菜单里立即检查或关闭自动更新。首次启用需执行一次 `bash codex-sidebar/macos/install.sh`，详见[自动更新说明](codex-sidebar/README.md#自动检查与编译更新macos)。

需要 Python 3.9 或更新版本。仅使用 Codex 侧栏时可以跳过本节。

### Windows（PowerShell）

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
# 编辑 .env，填写真实登录账号和密码
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000 --workers 1
```

无需激活虚拟环境或更改系统 PowerShell 执行策略；未安装 Python 时先安装 Python 3.9+。测试命令：`.\.venv\Scripts\python.exe -m pytest -q`。

### macOS / Linux

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
  -v sub2api-quota-data:/app/data \
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
| SUB2API_SHOW_FIVE_HOUR | 是否显示 5 小时窗口；设为 `false`/`0`/`no`/`off` 时 `/api/usage` 的 `five_hour` 返回 `null`，页面与侧栏一起隐藏 | true |
| SUB2API_QUOTA_PROXY_URL | 本地免密测试模式：指向已登录并部署好的额度服务前缀（如 `https://gateway.zhengru.top/api/quota`），无需配置 `SUB2API_EMAIL`/`SUB2API_PASSWORD` 即可拉取真实数据并在本地记录快照 | 无 |
| SUB2API_SNAPSHOT_DB | SQLite 额度快照数据库路径；设为 `off`/`false`/`0` 可关闭快照与直登估算 | data/quota_snapshots.db |
| SUB2API_SNAPSHOT_INTERVAL_SECONDS | 后台自动采样周期（秒）；设为 `0` 关闭后台定时采样，仅在 `/api/usage` 实时查询时记录快照 | 300 |
| SUB2API_SEVEN_DAY_COST_EQUIVALENT | 手动指定 100% 7 天额度对应的美元基准（如 `200`）；留空时根据快照自动估算 | 自动校准 |
| SUB2API_CREDIT_COST_RATIO | 1 点数余额（`credits.balance`）折算的美元系数 | 1.0 |

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
