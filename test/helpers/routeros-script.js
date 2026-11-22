// A small evaluator for the RouterOS subset emitted by voucher scripts, not a RouterOS syntax validator.
function tokenize(source) {
  const pattern = /\s+|"(?:\\.|[^"\\])*"|\$(?:"[^"]+"|[A-Za-z][A-Za-z0-9]*)|:[A-Za-z-]+|\/[A-Za-z][A-Za-z0-9/-]*|->|!=|<=|>=|[A-Za-z][A-Za-z0-9-]*|\d+(?:s)?|[{}[\]();,.=+*%<>/-]/gy;
  const tokens = [];
  let offset = 0;
  while (offset < source.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match) throw new Error(`Unsupported RouterOS token: ${source.slice(offset, offset + 40)}`);
    if (match[0].trim()) tokens.push(match[0]);
    offset = pattern.lastIndex;
  }
  return tokens;
}

function parse(source) {
  const tokens = tokenize(source);
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = (expected) => {
    const token = tokens[cursor++];
    if (expected && token !== expected) throw new Error(`Expected ${expected}, got ${token}`);
    return token;
  };
  const block = () => {
    take("{");
    const statements = sequence("}");
    take("}");
    return statements;
  };
  const precedence = { or: 1, and: 2, "=": 3, "!=": 3, "<": 3, ">": 3, "<=": 3, ">=": 3, ".": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6, "->": 7 };
  const expression = (minimum = 0) => {
    const token = take();
    let node;
    if (token === "(") {
      const values = [expression()];
      while (peek() === ",") { take(); values.push(expression()); }
      take(")");
      node = values.length === 1 ? values[0] : { kind: "array", values };
    } else if (token === "[") {
      node = command();
      take("]");
    } else if (token?.startsWith('"')) {
      node = { kind: "string", value: JSON.parse(token) };
    } else if (token?.startsWith("$")) {
      node = { kind: "variable", name: token.slice(1).replaceAll('"', "") };
    } else if (/^\d+$/.test(token)) {
      node = { kind: "literal", value: Number(token) };
    } else if (["true", "false"].includes(token)) {
      node = { kind: "literal", value: token === "true" };
    } else {
      if (!token || ["}", "]", ";"].includes(token)) throw new Error(`Expected expression, got ${token}`);
      node = { kind: "literal", value: token };
    }
    while ((precedence[peek()] || 0) > minimum) {
      const operator = take();
      node = { kind: "binary", operator, left: node, right: expression(precedence[operator]) };
    }
    return node;
  };
  const command = () => {
    const first = take();
    if (first.startsWith(":")) {
      const arity = { ":len": 1, ":typeof": 1, ":tonum": 1, ":totime": 1, ":tostr": 1, ":find": 2, ":pick": 3 }[first];
      if (!arity) throw new Error(`Unsupported expression command ${first}`);
      const args = [];
      for (let i = 0; i < arity && peek() !== "]"; i += 1) args.push(expression());
      return { kind: "builtin", name: first, args };
    }
    if (first.startsWith("$")) {
      const args = {};
      while (peek() !== "]") { const key = take(); take("="); args[key] = expression(); }
      return { kind: "call", name: first.slice(1), args };
    }
    const path = [];
    let action = first;
    if (first.startsWith("/")) {
      path.push(first.slice(1));
      while (!["get", "find", "add", "set", "remove"].includes(peek())) path.push(take());
      action = take();
    }
    const args = {};
    const positional = [];
    if (peek() === "where") take();
    while (peek() && ![";", "]", "}"].includes(peek())) {
      if (peek() === "and") { take(); continue; }
      if (tokens[cursor + 1] === "=") {
        const key = take(); take("="); args[key] = expression(3);
      } else {
        positional.push(expression());
      }
    }
    return { kind: "router", path: path.join("/"), action, args, positional };
  };
  const statement = () => {
    const token = take();
    if (token === ":local") {
      const name = take();
      if (peek() === "do") { take(); take("="); return { kind: "function", name, body: block() }; }
      return { kind: "local", name, value: expression() };
    }
    if (token === ":set") return { kind: "set", name: take(), value: expression() };
    if (token === ":if") {
      const condition = expression(); take("do"); take("=");
      const body = block();
      let otherwise = [];
      if (peek() === "else") { take(); take("="); otherwise = block(); }
      return { kind: "if", condition, body, otherwise };
    }
    if (token === ":foreach") {
      const name = take(); take("in"); take("="); const values = expression();
      take("do"); take("="); return { kind: "foreach", name, values, body: block() };
    }
    if (token === ":while") {
      const condition = expression(); take("do"); take("=");
      return { kind: "while", condition, body: block() };
    }
    if (token === ":do") {
      const body = block(); take("on-error"); take("=");
      return { kind: "try", body, handler: block() };
    }
    if ([":return", ":error", ":put", ":delay"].includes(token)) return { kind: token.slice(1), value: expression() };
    if (token === ":log") return { kind: "log", level: take(), value: expression() };
    cursor -= 1;
    return { kind: "command", value: command() };
  };
  const sequence = (end) => {
    const statements = [];
    while (peek() && peek() !== end) {
      if (peek() === ";") { take(); continue; }
      statements.push(statement());
    }
    return statements;
  };
  return sequence();
}

class Scope {
  constructor(parent, values = {}) { this.parent = parent; this.values = new Map(Object.entries(values)); }
  get(name) { return this.values.has(name) ? this.values.get(name) : this.parent?.get(name); }
  set(name, value) {
    if (this.values.has(name)) this.values.set(name, value);
    else if (this.parent) this.parent.set(name, value);
    else throw new Error(`Unknown variable ${name}`);
  }
}

class Returned { constructor(value) { this.value = value; } }
const toString = (value) => value == null ? "" : Array.isArray(value) ? value.join(";") : String(value);

function runRouterScript(source, { variables = {}, router, onDelay = () => {}, logs = [] } = {}) {
  const scope = new Scope(null, variables);
  const evaluate = (node, env, path = "") => {
    const ev = (value) => evaluate(value, env, path);
    if (node.kind === "literal") return node.value;
    if (node.kind === "variable") return env.get(node.name);
    if (node.kind === "string") return node.value.replace(/\$(?:"([^"]+)"|([A-Za-z][A-Za-z0-9]*))/g, (_, quoted, name) => toString(env.get(quoted || name)));
    if (node.kind === "array") return node.values.map(ev);
    if (node.kind === "binary") {
      const left = ev(node.left);
      if (node.operator === "and") return Boolean(left && ev(node.right));
      if (node.operator === "or") return Boolean(left || ev(node.right));
      const right = ev(node.right);
      return {
        "=": () => left === right, "!=": () => left !== right, "<": () => left < right,
        ">": () => left > right, "<=": () => left <= right, ">=": () => left >= right,
        "+": () => left + right, "-": () => left - right, "*": () => left * right, "/": () => Math.trunc(left / right),
        "%": () => left % right, ".": () => toString(left) + toString(right), "->": () => left?.[right],
      }[node.operator]();
    }
    if (node.kind === "builtin") {
      const args = node.args.map(ev);
      return {
        ":len": () => args[0]?.length ?? toString(args[0]).length,
        ":typeof": () => typeof args[0] === "number" ? "num" : args[0] == null ? "nil" : "str",
        ":tonum": () => /^-?\d+$/.test(toString(args[0])) ? Number(args[0]) : null,
        ":totime": () => { const match = /^(\d+)([smhd])$/.exec(args[0]); if (!match) throw new Error("Unsupported test duration"); return Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 })[match[2]]; },
        ":tostr": () => toString(args[0]),
        ":pick": () => args[0]?.slice(args[1], args[2]) ?? "",
        ":find": () => { const index = args[0].indexOf(args[1]); return index < 0 ? null : index; },
      }[node.name]();
    }
    if (node.kind === "call") {
      const func = env.get(node.name);
      const args = Object.fromEntries(Object.entries(node.args).map(([key, value]) => [key, ev(value)]));
      try { execute(func.body, new Scope(null, args)); }
      catch (error) { if (error instanceof Returned) return error.value; throw error; }
      return undefined;
    }
    if (node.kind === "router") {
      const commandPath = node.path || path;
      const valueFor = (value) => evaluate(value, env, commandPath);
      return router({
        path: commandPath, action: node.action,
        args: Object.fromEntries(Object.entries(node.args).map(([key, value]) => [key, valueFor(value)])),
        positional: node.positional.map(valueFor),
      });
    }
    throw new Error(`Unsupported expression ${node.kind}`);
  };
  const execute = (body, env) => {
    for (const node of body) {
      const ev = (value) => evaluate(value, env);
      if (node.kind === "local") env.values.set(node.name, ev(node.value));
      else if (node.kind === "function") env.values.set(node.name, node);
      else if (node.kind === "set") env.set(node.name, ev(node.value));
      else if (node.kind === "if") execute(ev(node.condition) ? node.body : node.otherwise, new Scope(env));
      else if (node.kind === "while") {
        let iterations = 0;
        while (ev(node.condition)) { if (++iterations > 1500) throw new Error("Test loop limit exceeded"); execute(node.body, new Scope(env)); }
      }
      else if (node.kind === "foreach") {
        for (const value of ev(node.values)) execute(node.body, new Scope(env, { [node.name]: value }));
      } else if (node.kind === "try") {
        try { execute(node.body, new Scope(env)); }
        catch (error) { if (error instanceof Returned) throw error; execute(node.handler, new Scope(env)); }
      } else if (node.kind === "return") throw new Returned(ev(node.value));
      else if (node.kind === "error") throw new Error(ev(node.value));
      else if (node.kind === "command" || node.kind === "put") ev(node.value);
      else if (node.kind === "delay") onDelay();
      else if (node.kind === "log") logs.push({ level: node.level, message: ev(node.value) });
      else throw new Error(`Unsupported statement ${node.kind}`);
    }
  };
  execute(parse(source), scope);
  return { scope, logs };
}

module.exports = { runRouterScript };
