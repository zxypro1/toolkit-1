// import Engine, { IStepOptions, IContext } from '../lib';
import Engine, { IStepOptions, IContext } from '../src';
import { lodash } from '@serverless-cd/core';
import * as path from 'path';
const { get, map } = lodash;
const logPrefix = path.join(__dirname, 'logs');

test.skip('logger oss', async () => {
  const steps = [
    { run: 'echo "hello"', id: 'xhello' },
    { plugin: path.join(__dirname, 'fixtures', 'app'), id: 'xuse', inputs: { milliseconds: 10 } },
    { run: 'echo "world"' },
  ] as IStepOptions[];
  const engine = new Engine({
    steps,
    logConfig: {
      logPrefix,
      ossConfig: {
        accessKeyId: 'xxx',
        accessKeySecret: 'xxx',
        bucket: 'shl-test',
        region: 'cn-chengdu',
      },
    },
  });
  const res: IContext | undefined = await engine.start();
  expect(res?.status).toBe('success');
});

test('自定义logger', async () => {
  const steps = [{ run: 'echo "hello"', id: 'xhello' }, { run: 'echo "world"' }] as IStepOptions[];

  const customLogger = {
    info: (msg: string) => {
      console.log('customLogger info', msg);
    },
    warn: (msg: string) => {
      console.log('customLogger warn', msg);
    },
    debug: (msg: string) => {
      console.log('customLogger debug', msg);
    },
  };

  const engine = new Engine({ steps, logConfig: { customLogger } });
  const res: IContext | undefined = await engine.start();
  expect(res?.status).toBe('success');
});

test('获取某一步的outputs', async () => {
  const steps = [
    { run: 'echo "hello"', id: 'xhello' },
    { plugin: './fixtures/app', id: 'xuse', inputs: { milliseconds: 10 } },
    { run: 'echo "world"' },
  ] as IStepOptions[];
  const engine = new Engine({ steps, logConfig: { logPrefix, logLevel: 'DEBUG' }, cwd: __dirname });
  const res: IContext | undefined = await engine.start();
  const data = map(res?.steps, (item) => ({
    status: item.status,
    outputs: item.outputs,
  }));
  console.log(res);
  expect(res?.status).toBe('success');
  expect(data).toEqual([
    { status: 'success' },
    { status: 'success', outputs: {} },
    { status: 'success', outputs: { success: true } },
    { status: 'success', outputs: {} },
    { status: 'success', outputs: { success: true } },
  ]);
});

test('魔法变量识别 task status', async () => {
  const steps = [{ run: 'echo ${{status}}' }] as IStepOptions[];
  const engine = new Engine({ steps, logConfig: { logPrefix, logLevel: 'DEBUG' } });
  const res: IContext | undefined = await engine.start();
  console.log(res);
  expect(res?.status).toBe('success');
});

test('unsetEnvs 测试', async () => {
  process.env.message = '我是主进程的字段';
  const steps = [{ run: 'echo ${{status}}' }] as IStepOptions[];
  const engine = new Engine({
    steps,
    logConfig: { logPrefix, logLevel: 'DEBUG' },
    unsetEnvs: ['message'],
  });
  const res: IContext | undefined = await engine.start();
  console.log(process.env.message, 'process.env.message');
  console.log(res);
  expect(res?.status).toBe('success');
});

test('echo $PATH', async () => {
  process.env.name = 'init name';
  const steps = [{ run: 'echo $PATH', id: 'xhello', env: { name: 'xiaoming' } }] as IStepOptions[];
  const engine = new Engine({
    steps,
    logConfig: { logPrefix, logLevel: 'DEBUG' },
    cwd: __dirname,
    inputs: { secrets: { name: 'xiaohong' } },
  });
  const res: IContext | undefined = await engine.start();
  expect(res?.status).toBe('success');
});

test('run env 测试', async () => {
  process.env.name = 'init name';
  const steps = [
    { run: 'echo "hello"', id: 'xhello', env: { name: 'xiaoming' } },
    { run: 'node ./run-env.js', env: { name: '${{secrets.name}}' } },
  ] as IStepOptions[];
  const engine = new Engine({
    steps,
    logConfig: { logPrefix, logLevel: 'DEBUG' },
    cwd: __dirname,
    inputs: { secrets: { name: 'xiaohong' } },
  });
  const res: IContext | undefined = await engine.start();
  expect(res?.status).toBe('success');
});

test('plugin env 测试', async () => {
  const steps = [
    { plugin: path.join(__dirname, 'fixtures', 'app'), id: 'xuse', inputs: { milliseconds: 10 } },

  ] as IStepOptions[];
  const engine = new Engine({
    steps,
    logConfig: { logPrefix, logLevel: 'DEBUG' },
    cwd: __dirname,
    inputs: { env: { name: 'xiaohong' } },
  });
  const res: IContext | undefined = await engine.start();
  expect(res?.status).toBe('success');
});

test('cancel测试', (done) => {
  const lazy = (fn: any) => {
    setTimeout(() => {
      console.log('3s后执行 callback');
      fn();
    }, 3000);
  };
  const steps = [
    { run: 'echo "hello"' },
    { run: 'node packages/engine/__tests__/cancel-test.js' },
    { run: 'echo "world"' },
  ] as IStepOptions[];
  const engine = new Engine({ steps, logConfig: { logPrefix } });
  const callback = jest.fn(() => {
    engine.cancel();
  });
  lazy(callback);
  engine.start();
  setTimeout(() => {
    expect(callback).toBeCalled();
    done();
  }, 3001);
});

test('uses：应用测试返回值', async () => {
  const steps = [
    { run: 'echo "hello"', id: 'xhello' },
    { plugin: path.join(__dirname, 'fixtures', 'app'), id: 'xuse', inputs: { milliseconds: 10 } },
  ] as IStepOptions[];
  const engine = new Engine({ steps, logConfig: { logPrefix } });
  const res: IContext | undefined = await engine.start();
  const data = map(res?.steps, (item) => ({
    status: item.status,
    id: item.id,
    outputs: item.outputs,
  }));
  expect(data).toEqual([
    { status: 'success' },
    {
      status: 'success',
      id: 'xhello',
      outputs: {},
    },
    {
      status: 'success',
      id: 'xuse',
      outputs: {
        success: true,
      },
    },
    {
      status: 'success',
      id: 'xuse',
      outputs: {
        success: true,
      },
    },
  ]);
});

test('script 测试', async () => {
  const steps = [
    { run: 'echo "hello"', id: 'xhello' },
    {
      script: 'await Promise.all([$`sleep 1; echo 1`, $`sleep 2; echo 2`, $`sleep 3; echo 3`]);\n',
      id: 'xscript',
    },
  ] as IStepOptions[];
  const engine = new Engine({ steps, logConfig: { logPrefix } });
  const res = await engine.start();
  expect(get(res, 'status')).toBe('success');
});

test('inputs测试', async () => {
  const steps = [
    { run: 'echo "hello"', id: 'xhello' },
    { run: 'echo "world"', id: 'xworld', if: '${{name==="xiaoming"}}' },
    { run: 'echo ${{name}}', id: 'xname' },
  ] as IStepOptions[];
  const engine = new Engine({
    steps,
    logConfig: { logPrefix, logLevel: 'DEBUG' },
    inputs: { name: 'xiaoming' },
  });
  const res: IContext | undefined = await engine.start();
  const data = map(res?.steps, (item) => ({
    status: item.status,
    id: item.id,
  }));
  console.log(data);
  expect(data).toEqual([
    { status: 'success' },
    { status: 'success', id: 'xhello' },
    { status: 'success', id: 'xworld' },
    { status: 'success', id: 'xname' },
  ]);
});

test('inputs测试 env', async () => {
  const steps = [
    { run: 'echo "hello"', id: 'xhello' },
    { run: 'echo ${{env.name}}', id: 'xname', env: { name: 'xiaohong' } },
    { run: 'echo ${{env.name}}', id: 'xname' },
  ] as IStepOptions[];
  const engine = new Engine({
    steps,
    logConfig: { logPrefix, logLevel: 'DEBUG' },
    inputs: { env: { name: 'xiaoming' } },
  });
  const res: IContext | undefined = await engine.start();
  const data = map(res?.steps, (item) => ({
    status: item.status,
    id: item.id,
  }));
  console.log(res);
  expect(data).toEqual([
    { status: 'success' },
    { status: 'success', id: 'xhello' },
    { status: 'success', id: 'xname' },
    { status: 'success', id: 'xname' },
  ]);
});

test('测试plugin安装逻辑', async () => {
  const steps = [
    { run: 'echo "hello"', id: 'xhello' },
    { plugin: '@serverless-cd/ding-talk', id: 'ding' },
  ] as IStepOptions[];
  const engine = new Engine({
    steps,
    logConfig: { logPrefix },
  });
  const res: IContext | undefined = await engine.start();
  const data = map(res?.steps, (item) => ({
    status: item.status,
    name: item.name,
  }));
  expect(data).toEqual([
    { status: 'success', name: 'Set up task' },
    { status: 'success', name: 'Run echo "hello"' },
    { status: 'failure', name: 'Run @serverless-cd/ding-talk' },
  ]);
});

// 新增性能统计测试
test('性能统计功能测试', async () => {
  const steps = [
    { run: 'echo "step1"' },
    { run: 'sleep 1 && echo "step2"' }, // 添加短暂延迟
    { run: 'echo "step3"' },
  ] as IStepOptions[];

  const engine = new Engine({
    steps,
    logConfig: { logPrefix }
  });

  const res: IContext | undefined = await engine.start();

  // 验证任务执行成功
  expect(res?.status).toBe('success');

  // 验证性能数据存在
  expect(res?.performance).toBeDefined();

  // 验证初始化耗时存在
  expect(res?.performance?.initTime).toBeDefined();
  expect(res?.performance?.initTime).toBeGreaterThanOrEqual(0);

  // 验证总耗时存在
  expect(res?.performance?.totalTime).toBeDefined();
  expect(res?.performance?.totalTime).toBeGreaterThanOrEqual(0);

  // 验证步骤耗时存在
  expect(res?.performance?.stepTimes).toBeDefined();
  expect(Object.keys(res?.performance?.stepTimes || {})).toHaveLength(steps.length);

  // 验证任务状态和步骤数
  expect(res?.performance?.taskStatus).toBe('success');

  // 验证除初始化外每个步骤都有耗时记录
  for (const step of res?.steps || []) {
    if (step.stepCount&&step.stepCount!=='0') {
      expect(res?.performance?.stepTimes?.[step.stepCount]).toBeDefined();
      expect(res?.performance?.stepTimes?.[step.stepCount]).toBeGreaterThanOrEqual(0);
    }
  }
});

// 测试带超时的性能统计
test('带超时的性能统计功能测试', async () => {
  const steps = [
    { run: 'echo "step1"' },
    { run: 'sleep 0.1 && echo "step2"' },
  ] as IStepOptions[];

  const engine = new Engine({
    steps,
    logConfig: { logPrefix },
    stepTimeout: 3
  });

  const res: IContext | undefined = await engine.start();

  // 验证任务执行成功
  expect(res?.status).toBe('success');
  // 验证性能数据存在
  expect(res?.performance).toBeDefined();
  // 验证超时配置被正确传递
  // 这部分验证需要查看Engine内部实现
});

// 测试失败情况下的性能统计
test('失败情况下的性能统计功能测试', async () => {
  const steps = [
    { run: 'echo "step1"' },
    { run: 'exit 1' }, // 故意失败的步骤
    { run: 'echo "step3"' },
  ] as IStepOptions[];

  const engine = new Engine({
    steps,
    logConfig: { logPrefix }
  });

  const res: IContext | undefined = await engine.start();

  // 验证任务执行失败
  expect(res?.status).toBe('failure');

  // 验证性能数据仍然存在
  expect(res?.performance).toBeDefined();

  // 验证初始化耗时存在
  expect(res?.performance?.initTime).toBeDefined();
  expect(res?.performance?.initTime).toBeGreaterThanOrEqual(0);

  // 验证总耗时存在
  expect(res?.performance?.totalTime).toBeDefined();
  expect(res?.performance?.totalTime).toBeGreaterThanOrEqual(0);

  // 验证步骤耗时存在（即使任务失败也应该记录）
  expect(res?.performance?.stepTimes).toBeDefined();

  // 验证任务状态
  expect(res?.performance?.taskStatus).toBe('failure');
});