import { startWorkspaceConsole } from '../src/workspace-console.js';
import { CONSOLE_PORT } from '../src/console-entry.js';
try {
  const { server, url } = await startWorkspaceConsole(process.env.STEWARD_CONFIG ?? 'steward.config.json',CONSOLE_PORT);
  console.log(`分身控制台：${url}\n仅监听本机。按 Ctrl+C 关闭控制台服务。`);
  process.on('SIGINT', () => server.close());
  process.on('SIGTERM', () => server.close());
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') console.error('控制台端口已占用。如果分身服务正在运行，请使用它的控制台；独立控制台与机器人服务不能同时启动。');
  else throw error;
  process.exitCode=1;
}
