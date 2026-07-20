LOOP Creator OS MVP（Windows 快速使用说明）

一、启动
1. 请保留完整项目目录，不要只复制本 EXE；
2. 确认 Windows 已安装 Node.js 22.13 或更高版本；
3. 双击 LOOP-Creator-OS-MVP.exe；
4. 首次启动会自动安装缺失依赖，可能需要几分钟；
5. 浏览器会打开 http://127.0.0.1:8877/；如果没有自动打开，可手动访问该地址。

二、首次初始化
1. 选择“纯模板”或“AI 个性化开场”；
2. 添加并测试至少一个 Gmail、Outlook 或 SMTP 发件邮箱；
3. 只有 AI 个性化模式才需要模型 API Key；
4. 初始化不会发送邮件，真实发送必须经过逐封审批和第二次 LIVE 确认。

三、关闭
右键 Windows 右下角 LOOP 托盘图标，选择“退出并停止服务”。只关闭浏览器不会停止后台服务。

四、无法启动时
1. 确认 EXE 仍在 ui/release 目录；
2. 确认 Node.js 版本满足要求；
3. 查看 ui/server-data/launcher.log；
4. 从托盘退出旧进程后重新启动。

五、安全提示
- 请先使用 1–3 个团队内部邮箱完成测试；
- 出现 delivery_unknown 时不要重发，应先检查 Sent 文件夹；
- OAuth Token、SMTP 密码和 API Key 只保存在当前进程内存中，重启后需要重新输入；
- 当前 EXE 未做商业代码签名，Windows 可能显示 SmartScreen 提示；正式分发前应使用公司的代码签名证书签名。

完整中文手册：仓库根目录 README.zh-CN.md
