import { startWorkspaceConsole } from '../src/workspace-console.js';
const { server, url } = await startWorkspaceConsole(process.env.STEWARD_CONFIG ?? 'steward.config.json');
console.log(`工作空间授权：${url}\n仅监听本机。按 Ctrl+C 关闭授权页面服务。`);
process.on('SIGINT', () => server.close());
process.on('SIGTERM', () => server.close());
