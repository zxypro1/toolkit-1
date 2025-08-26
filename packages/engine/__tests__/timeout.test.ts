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
        run: 'echo "go sleep 3" && sleep 2',
        timeout: 3, // 2秒超时
      },
      {
        run: 'sleep 3',
        timeout: 2,
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
    console.log(result);
    // 当 continue-on-error 生效时，整个任务应该是成功的
    expect(result.status).toBe('success');
    // 应该有3个步骤（包括初始化步骤）
    expect(result.steps.length).toBe(3);
    // 初始化步骤应该成功
    expect(result.steps[0].status).toBe('success');
    // 第一个步骤应该标记为 error-with-continue
    expect(result.steps[1].status).toBe('error-with-continue');
    // 第二个步骤应该成功执行
    expect(result.steps[2].status).toBe('success');
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
    console.log(result);
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

  // 添加新的测试用例
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
    console.log(result);
    // 当 continue-on-error 生效时，整个任务应该是成功的
    expect(result.status).toBe('success');
    // 应该有3个步骤（包括初始化步骤）
    expect(result.steps.length).toBe(3);
    // 初始化步骤应该成功
    expect(result.steps[0].status).toBe('success');
    // 第一个步骤应该标记为 error-with-continue
    expect(result.steps[1].status).toBe('error-with-continue');
    // 第一个步骤应该包含错误信息
    expect(result.steps[1].error).toBeInstanceOf(TimeoutError);
    expect(result.steps[1].error!.message).toContain('Step');
    expect(result.steps[1].error!.message).toContain('timeout after 1s');
    // 第二个步骤应该成功执行
    expect(result.steps[2].status).toBe('success');
  });

  // 添加全局超时测试用例
  test('全局超时功能', async () => {
    const steps = [
      {
        run: 'sleep 1',
      },
      {
        run: 'sleep 1',
      },
      {
        run: 'sleep 5',
      },
    ] as IStepOptions[];

    const globalTimeout = 3

    const engine = new Engine({
      steps,
      timeout: globalTimeout, // 全局超时3秒
      logConfig: { logPrefix },
    });

    const result = await engine.start();
    console.log(result);
    // 整个任务应该因全局超时而失败
    expect(result.status).toBe('timeout-failure');
    // 应该有2个步骤（包括初始化步骤）
    expect(result.steps.length).toBe(4);
    expect(result.steps[0].status).toBe('success');
    expect(result.steps[1].status).toBe('success');
    expect(result.steps[2].status).toBe('success');
    expect(result.steps[3].status).toBe('timeout-failure');
    expect(result.steps[3].error).toBeInstanceOf(TimeoutError);
    expect(result.steps[3].error!.message).toContain(`Global timeout after ${globalTimeout}s`);
  });
});