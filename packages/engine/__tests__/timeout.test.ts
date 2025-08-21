import Engine, { IStepOptions } from '../src';
import * as path from 'path';
import { TimeoutError } from '../src/types';

const logPrefix = path.join(__dirname, 'logs/performance');

describe('Engine超时相关单测', () => {
  beforeEach(() => {
    // 清理日志目录
    const fs = require('fs');
    if (fs.existsSync(logPrefix)) {
      const rimraf = require('rimraf');
      rimraf.sync(logPrefix);
    }
  });

  test('step1超时', async () => {
    const steps = [
      {
        run: 'sleep 1',
        timeout: 2, // 2秒超时
      },
      {
        run: 'sleep 3',
        timeout: 2,
      },
      {
        run: 'sleep 1',
      }
    ] as IStepOptions[];
    const engine = new Engine({
      steps,
      stepTimeout:2,
      logConfig: { logPrefix, logLevel: 'DEBUG' },
    });

    const result = await engine.start();
    console.log(result);
    expect(result.status).toBe('timeout-failure');
    expect(result.steps[2].error).toBeInstanceOf(TimeoutError);
    expect(result.steps[2].error!.message).toContain('Step');
    expect(result.steps[2].error!.message).toContain('timeout after 2s');
  });

  test('plugin超时', async () => {
    // 创建一个会超时的插件
    const steps = [
      {
        plugin: path.join(__dirname, 'fixtures', 'timeout-plugin'),
        timeout: 1, // 1秒超时
      },
    ] as IStepOptions[];

    const engine = new Engine({
      steps,
      logConfig: { logPrefix },
    });

    const result = await engine.start();
    expect(result.status).toBe('timeout-failure');
    expect(result.steps[1].error).toBeInstanceOf(TimeoutError);
    expect(result.steps[1].error!.message).toContain('Step');
    expect(result.steps[1].error!.message).toContain('timeout after 1s');
  });

  test('Engine全局step配置超时', async () => {
    const steps = [
      {
        run: 'sleep 3',
      },
    ] as IStepOptions[];

    const engine = new Engine({
      steps,
      stepTimeout: 1, // 1秒超时
      logConfig: { logPrefix },
    });

    const result = await engine.start();
    expect(result.status).toBe('timeout-failure');
    expect(result.steps[1].error).toBeInstanceOf(TimeoutError);
    expect(result.steps[1].error!.message).toContain('Step');
    expect(result.steps[1].error!.message).toContain('timeout after 1s');
  });

  test('超时后不执行后续步骤', async () => {
    const steps = [
      {
        run: 'sleep 3',
        timeout: 1, // 步骤超时1秒
      },
      {
        run: 'sleep 1', // 这个步骤不会执行到
      },
    ] as IStepOptions[];

    const engine = new Engine({
      steps,
      stepTimeout: 5, // 引擎默认超时5秒
      logConfig: { logPrefix },
    });

    const result = await engine.start();
    expect(result.status).toBe('timeout-failure');
    expect(result.steps[1].error).toBeInstanceOf(TimeoutError);
    expect(result.steps[1].error!.message).toContain('Step');
    expect(result.steps[1].error!.message).toContain('timeout after 1s');
  });

  test('成功执行，不超时', async () => {
    const steps = [
      {
        run: 'echo "quick command"',
        timeout: 5, // 5秒超时
      },
    ] as IStepOptions[];

    const engine = new Engine({
      steps,
      logConfig: { logPrefix },
    });

    const result = await engine.start();
    expect(result.status).toBe('success');
  });

  test('continue-on-error 在 step 超时时生效', async () => {
    const steps = [
      {
        run: 'sleep 3',
        timeout: 1, // 1秒超时
        'continue-on-error': true,
      },
      {
        run: 'echo "next step"',
      },
    ] as IStepOptions[];

    const engine = new Engine({
      steps,
      logConfig: { logPrefix },
    });

    const result = await engine.start();
    // 第一个步骤应该超时但继续执行
    expect(result.status).toBe('success');
    // 应该有3个步骤（包括初始化步骤）
    expect(result.steps.length).toBe(3);
    // 初始化步骤应该成功
    expect(result.steps[0].status).toBe('success');
    // 第一个步骤应该超时但继续
    expect(result.steps[1].status).toBe('error-with-continue');
    // 第二个步骤应该成功
    expect(result.steps[2].status).toBe('success');
    // 检查第一个步骤的错误信息
    expect(result.steps[1].error).toBeInstanceOf(TimeoutError);
    expect(result.steps[1].error!.message).toContain('Step');
    expect(result.steps[1].error!.message).toContain('timeout after 1s');
  });

  test('step超时时没有continue-on-error不继续执行', async () => {
    const steps = [
      {
        run: 'sleep 3',
        timeout: 1, // 1秒超时
        // 没有 continue-on-error
      },
      {
        run: 'echo "next step"',
      },
    ] as IStepOptions[];

    const engine = new Engine({
      steps,
      logConfig: { logPrefix },
    });

    const result = await engine.start();
    // 第一个步骤超时失败，不继续执行
    expect(result.status).toBe('timeout-failure');
    // 应该有3个步骤（包括初始化步骤）
    expect(result.steps.length).toBe(3);
    // 初始化步骤应该成功
    expect(result.steps[0].status).toBe('success');
    // 第一个步骤应该超时失败
    expect(result.steps[1].status).toBe('timeout-failure');
    // 第二个步骤应该跳过
    expect(result.steps[2].status).toBe('skipped');
    // 检查第一个步骤的错误信息
    expect(result.steps[1].error).toBeInstanceOf(TimeoutError);
    expect(result.steps[1].error!.message).toContain('Step');
    expect(result.steps[1].error!.message).toContain('timeout after 1s');
  });

  test('超时配置优先级：step配置超时优先于全局默认超时', async () => {
    const steps = [
      {
        run: 'sleep 3',
        timeout: 2, // step配置超时2秒
      },
    ] as IStepOptions[];

    const engine = new Engine({
      steps,
      stepTimeout: 1, // 全局默认超时1秒（小于step配置超时）
      logConfig: { logPrefix },
    });

    // 应该在2秒后超时，因为step配置超时优先于全局默认超时
    const startTime = Date.now();
    const result = await engine.start();
    const duration = Date.now() - startTime;

    expect(result.status).toBe('timeout-failure');
    expect(result.steps[1].error).toBeInstanceOf(TimeoutError);
    expect(result.steps[1].error!.message).toContain('Step');
    expect(result.steps[1].error!.message).toContain('timeout after 2s');
    // 应该在2秒左右超时
    expect(duration).toBeGreaterThan(1500);
    expect(duration).toBeLessThan(3500);
  });

  test('超时配置优先级：step配置超时优先于全局默认超时，此时应该成功', async () => {
    const steps = [
      {
        run: 'sleep 3',
        timeout: 4, // step配置超时2秒
      },
    ] as IStepOptions[];
    const engine = new Engine({
      steps,
      stepTimeout: 1, // 全局默认超时1秒
      logConfig: { logPrefix },
    });
    const startTime = Date.now();
    const result = await engine.start();
    const duration = Date.now() - startTime;
    expect(result.status).toBe('success');
    expect(duration).toBeGreaterThan(2500);
    expect(duration).toBeLessThan(4500);
  });

  // 全局超时测试
  test('全局超时：单个步骤执行时间正常但总时间超过全局超时', async () => {
    const steps = [
      {
        run: 'sleep 2', // 第一个步骤2秒
      },
      {
        run: 'sleep 2', // 第二个步骤2秒
      },
    ] as IStepOptions[];

    const engine = new Engine({
      steps,
      timeout: 3, // 全局超时3秒（总共需要4秒以上）
      stepTimeout: 10, // 单个步骤超时10秒
      logConfig: { logPrefix },
    });

    const startTime = Date.now();
    const result = await engine.start();
    const duration = Date.now() - startTime;

    expect(result.status).toBe('timeout-failure');
    expect(result.error).toBeInstanceOf(TimeoutError);
    expect(result.error!.message).toContain('Global timeout after 3s');
    // 应该在3秒左右超时
    expect(duration).toBeGreaterThan(2500);
    expect(duration).toBeLessThan(4000);
  });

  test('全局超时：在第一个步骤中就触发全局超时', async () => {
    const steps = [
      {
        run: 'sleep 5', // 第一个步骤5秒
      },
      {
        run: 'echo "second step"', // 第二个步骤不应该执行
      },
    ] as IStepOptions[];

    const engine = new Engine({
      steps,
      timeout: 2, // 全局超时2秒
      stepTimeout: 10, // 单个步骤超时10秒
      logConfig: { logPrefix },
    });

    const startTime = Date.now();
    const result = await engine.start();
    const duration = Date.now() - startTime;

    expect(result.status).toBe('timeout-failure');
    expect(result.error).toBeInstanceOf(TimeoutError);
    expect(result.error!.message).toContain('Global timeout after 2s');
    // 应该在2秒左右超时
    expect(duration).toBeGreaterThan(1500);
    expect(duration).toBeLessThan(3000);
    // 第二个步骤应该跳过
    expect(result.steps.length).toBe(3); // 初始化 + 第一个步骤 + 第二个步骤(未处理)
    expect(result.steps[2].status).toBe('pending'); // 第二个步骤由于全局超时而未被处理
  });

  test('全局超时：步骤超时优先级高于全局超时', async () => {
    const steps = [
      {
        run: 'sleep 3',
        timeout: 1, // 步骤超时1秒
      },
    ] as IStepOptions[];

    const engine = new Engine({
      steps,
      timeout: 5, // 全局超时5秒
      logConfig: { logPrefix },
    });

    const startTime = Date.now();
    const result = await engine.start();
    const duration = Date.now() - startTime;

    // 应该是步骤超时，而不是全局超时
    expect(result.status).toBe('timeout-failure');
    expect(result.steps[1].error).toBeInstanceOf(TimeoutError);
    expect(result.steps[1].error!.message).toContain('Step');
    expect(result.steps[1].error!.message).toContain('timeout after 1s');
    // 应该在1秒左右超时
    expect(duration).toBeGreaterThan(500);
    expect(duration).toBeLessThan(2000);
  });

  test('全局超时：正常执行不超时', async () => {
    const steps = [
      {
        run: 'echo "step 1"',
      },
      {
        run: 'echo "step 2"',
      },
    ] as IStepOptions[];

    const engine = new Engine({
      steps,
      timeout: 10, // 全局超时10秒
      logConfig: { logPrefix },
    });

    const result = await engine.start();
    expect(result.status).toBe('success');
    expect(result.error).toBeUndefined();
  });

  test('全局超时：全局超时时continue-on-error不生效', async () => {
    const steps = [
      {
        run: 'sleep 2',
        'continue-on-error': true,
      },
      {
        run: 'echo "second step"',
      },
    ] as IStepOptions[];

    const engine = new Engine({
      steps,
      timeout: 1, // 全局超时1秒
      logConfig: { logPrefix },
    });

    const result = await engine.start();
    expect(result.status).toBe('timeout-failure');
    expect(result.error).toBeInstanceOf(TimeoutError);
    expect(result.error!.message).toContain('Global timeout after 1s');
    // 后续步骤不应该执行
    expect(result.steps.length).toBe(3); // 初始化 + 第一个步骤 + 第二个步骤(未处理)
    expect(result.steps[2].status).toBe('pending'); // 第二个步骤由于全局超时而未被处理
  });
});