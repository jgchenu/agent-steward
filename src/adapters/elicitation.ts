import type { HumanRequest } from '../types.js';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const secret = /password|passwd|secret|token|credential|cookie|密码|密钥/i;
// Support the bounded primitive form subset. URL/authentication and biometric flows stay local.
export function elicitation(p: any, respond: (value: unknown) => void): HumanRequest {
  if (!['form', 'openai/form', 'openaiForm'].includes(p.mode) || typeof p.serverName !== 'string'
    || typeof p.message !== 'string' || !p.message.trim()) throw Error('此工具确认格式尚不支持，请在本机处理；没有授予权限。');
  const schema = p.requestedSchema;
  if (!object(schema) || schema.type !== 'object' || !object(schema.properties)
    || Object.keys(schema).some(k => !['type','properties','required','$schema','title','description','additionalProperties'].includes(k))
    || (schema.additionalProperties !== undefined && schema.additionalProperties !== false)) throw Error('无法完整解释工具表单，未授予权限。');
  const fields = Object.entries(schema.properties), required = schema.required ?? [];
  if (!Array.isArray(required) || required.some(k => typeof k !== 'string' || !Object.hasOwn(schema.properties, k)) || fields.length > 12) throw Error('工具表单超出支持范围，未授予权限。');
  if (p._meta && (p._meta['openai/elicitation.userVerification'] || p._meta.userVerification)) throw Error('身份验证必须在本机完成。');
  for (const [key, field] of fields) {
    if (secret.test(key + ' ' + JSON.stringify(field))) throw Error('敏感输入必须在本机完成，不会转发到群聊。');
    if (!object(field) || !['string','boolean','number','integer'].includes(field.type)
      || Object.keys(field).some(k => !['type','title','description','enum','minLength','maxLength','minimum','maximum'].includes(k))
      || (field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length || field.enum.some((v: unknown) => !['string','number','boolean'].includes(typeof v))))) throw Error('工具表单包含尚不支持的字段，未授予权限。');
    for (const k of ['minLength','maxLength','minimum','maximum']) if (field[k] !== undefined && !Number.isFinite(field[k])) throw Error('工具表单约束无效。');
  }
  const description = `工具确认 · ${p.serverName}\n${p.message}\n仅回答本次请求，不授予长期或整个会话权限。`
    + (fields.length ? `\n请通过卡片提交 JSON；不要在群里输入密码或凭据。\n${JSON.stringify(schema, null, 2)}` : '');
  if (Buffer.byteLength(description) > 12_000) throw Error('工具确认内容过长，无法完整展示，未授予权限。');
  const parse = (answer: string) => {
    let value: unknown; try { value = JSON.parse(answer); } catch { throw Error('请按展示的字段填写 JSON 对象。'); }
    if (!object(value) || Object.keys(value).some(k => !Object.hasOwn(schema.properties, k)) || required.some(k => !Object.hasOwn(value, k))) throw Error('回答缺少必填字段或包含未知字段。');
    for (const [key, field] of fields) {
      if (!Object.hasOwn(value, key)) continue;
      const v = value[key];
      if (typeof v !== (field.type === 'integer' ? 'number' : field.type) || (typeof v === 'number' && (!Number.isFinite(v) || (field.type === 'integer' && !Number.isInteger(v))))
        || (field.enum && !field.enum.includes(v)) || (typeof v === 'string' && ((field.minLength !== undefined && v.length < field.minLength) || (field.maxLength !== undefined && v.length > field.maxLength)))
        || (typeof v === 'number' && ((field.minimum !== undefined && v < field.minimum) || (field.maximum !== undefined && v > field.maximum)))) throw Error(`字段 ${key} 不符合要求。`);
    }
    return value;
  };
  return fields.length ? { kind: 'input', explicit: true, description, validate: answer => { parse(answer); },
    resolve: answer => respond({ action: 'accept', content: parse(answer), _meta: null }) }
    : { kind: 'approval', description, resolve: answer => respond({ action: answer === 'accept' ? 'accept' : 'decline', content: answer === 'accept' ? {} : null, _meta: null }) };
}
