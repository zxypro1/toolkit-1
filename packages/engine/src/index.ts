import { EngineLogger, getArtTemplate, lodash } from '@serverless-cd/core';
import { createMachine, interpret } from 'xstate';
import { command } from 'execa';
import * as path from 'path';
import os from 'os';
import { IStepOptions, IRunOptions, IPluginOptions, IRecord, IStatus, IEngineOptions, IContext, ILogConfig, STEP_STATUS, STEP_STATUS_BASE,ISteps, STEP_IF, EReportType,TimeoutError,IPerformanceData } from './types';
import { parsePlugin, getProcessTime, getDefaultInitLog, getLogPath, getPluginRequirePath, stringify, getUserAgent, TAG_MESSAGE } from './utils';
import { INIT_STEP_COUNT, INIT_STEP_NAME, COMPLETED_STEP_COUNT, DEFAULT_COMPLETED_LOG, SERVERLESS_CD_KEY, SERVERLESS_CD_VALUE, REPORT_BASE_URL } from './constants';
import execDaemon from './exec-daemon';
import { filter, join } from 'lodash';
import fs from 'fs';

export { IStepOptions, IContext } from './types';

const { isEmpty, get, each, replace, map, find, isFunction, values, has, concat } = lodash;
const debug = require('@serverless-cd/debug')('serverless-cd:engine');

class Engine {
  private childProcess: any[] = [];
  public context = { status: STEP_STATUS.PENING, completed: false } as IContext;
  private record = { status: STEP_STATUS.PENING, editStatusAble: true } as IRecord;
  private logger: any;
  private stepTimeoutId: NodeJS.Timeout | null = null; // 步骤超时定时器
  private globalTimeoutId: NodeJS.Timeout | null = null; // 全局超时定时器
  private globalTimeoutPromise: Promise<never> | null = null; // 全局超时Promise
  private startTime: number = 0; // 任务开始时间
  private initStartTime: number = 0; // 初始化开始时间
  constructor(private options: IEngineOptions) {
    debug('engine start');
    debug(`engine options: ${stringify(options)}`);

    process.env[SERVERLESS_CD_KEY] = SERVERLESS_CD_VALUE;
    const { inputs, cwd = process.cwd(), logConfig = {},stepTimeout,timeout } = options;
    this.options.logConfig = logConfig;
    // 记录上下文信息
    this.context.cwd = cwd;
    this.context.inputs = inputs as {};
    stepTimeout && (this.context.stepTimeout = stepTimeout);
    timeout && (this.context.timeout = timeout);
    this.context.performance = {
      stepTimes: {},
    } as IPerformanceData;
    // 初始化全局超时
    this.setupGlobalTimeout();
    this.doUnsetEnvs();
  }
  private async doUnsetEnvs() {
    const { unsetEnvs } = this.options;
    if (!isEmpty(unsetEnvs)) {
      each(unsetEnvs, (item) => {
        delete process.env[item];
      });
    }
  }
  private async doInit() {
    this.initStartTime = Date.now(); // 记录初始化开始时间
    const { events } = this.options;
    this.context.status = STEP_STATUS.RUNNING;
    const startTime = Date.now();
    const filePath = getLogPath(INIT_STEP_COUNT);
    this.logger = this.getLogger(filePath);
    this.logger.info(TAG_MESSAGE.INIT_START);
    this.logger.info(getDefaultInitLog());
    try {
      const res = await events?.onInit?.(this.context, this.logger);
      // onInit 不存在时，也需要执行以下逻辑
      const process_time = getProcessTime(startTime);
      this.record.initData = {
        name: get(res, 'name', INIT_STEP_NAME),
        status: STEP_STATUS.SUCCESS,
        process_time,
        stepCount: INIT_STEP_COUNT,
        outputs: res,
      };
      // 优先读取 doInit 返回的 steps 数据，其次 行参里的 steps 数据
      const steps = await parsePlugin(res?.steps || this.options.steps, this);
      const initTime = getProcessTime(this.initStartTime);
      if (this.context.performance) {
        this.context.performance.initTime = initTime;
      }
      await this.doOss(filePath);
      this.logger.info(TAG_MESSAGE.INIT_SUCCESS);
      return { ...res, steps };
    } catch (error) {
      debug(`onInit error: ${error}`);
      this.outputErrorLog(error as Error);
      this.context.status = this.record.status = STEP_STATUS.FAILURE;
      const process_time = getProcessTime(startTime);
      this.record.initData = {
        name: INIT_STEP_NAME,
        status: STEP_STATUS.FAILURE,
        process_time,
        stepCount: INIT_STEP_COUNT,
        error,
      };
      this.context.error = error as Error;
      const steps = await parsePlugin(this.options.steps as IStepOptions[], this);
      const initTime = getProcessTime(this.initStartTime);
      if (this.context.performance) {
        this.context.performance.initTime = initTime;
      }
      await this.doOss(filePath);
      this.logger.info(TAG_MESSAGE.INIT_FAIL);
      return { steps };
    }
  }
  async start(): Promise<IContext> {
    this.startTime = Date.now();
    const { steps } = await this.doInit();
    if (isEmpty(steps)) {
      this.recordContext(this.record.initData as IStepOptions);
      await this.doCompleted();
      return this.context;
    }
    this.context.steps = map(steps as ISteps[], (item) => {
      item.status = STEP_STATUS.PENING;
      const tmpTimeout = item.timeout || this.options.stepTimeout;
      tmpTimeout && (item.timeout = tmpTimeout);
      return item;
    });
    return new Promise(async (resolve) => {
      const states: any = {
        init: {
          on: {
            INIT: get(steps, '[0].stepCount'),
          },
        },
        final: {
          type: 'final',
          invoke: {
            src: async () => {
              // 执行终态是 error-with-continue 的时候，改为 success
              const status =
                this.record.status === STEP_STATUS.ERROR_WITH_CONTINUE
                  ? STEP_STATUS.SUCCESS
                  : this.record.status;
              this.context.status = status;
              await this.doCompleted();
              if (status === STEP_STATUS.SUCCESS) {
                this.report();
              }
              debug('engine end');
              resolve(this.context);
            },
          },
        },
      };

      each(steps, (item, index) => {
        const target = steps[index + 1] ? get(steps, `[${index + 1}].stepCount`) : 'final';
        states[item.stepCount as string] = {
          invoke: {
            id: item.stepCount,
            src: async () => {
              this.record.startTime = Date.now();
              // logger
              this.logger = this.getLogger(getLogPath(item.stepCount));
              // 记录 context
              this.recordContext(item, { status: STEP_STATUS.RUNNING });
              // 记录环境变量
              this.context.env = item.env as {};
              // 先判断if条件，成功则执行该步骤。
              if (item.if) {
                // 替换 failure()
                item.if = replace(
                  item.if,
                  STEP_IF.FAILURE,
                  this.record.status === STEP_STATUS.FAILURE ? 'true' : 'false',
                );
                // 替换 success()
                item.if = replace(
                  item.if,
                  STEP_IF.SUCCESS,
                  this.record.status !== STEP_STATUS.FAILURE ? 'true' : 'false',
                );
                // 替换 cancelled()
                item.if = replace(
                  item.if,
                  STEP_IF.CANCEL,
                  this.record.status === STEP_STATUS.CANCEL ? 'true' : 'false',
                );
                // 替换 always()
                item.if = replace(item.if, STEP_IF.ALWAYS, 'true');
                item.if = this.doArtTemplateCompile(item.if);
                return item.if === 'true' ? this.handleSrc(item) : this.doSkip(item);
              }
              // 如果已取消，则不执行该步骤, 并记录状态为 cancelled
              if (this.record.status === STEP_STATUS.CANCEL) return this.doCancel(item);
              // 其次检查全局的执行状态，如果是failure，则不执行该步骤, 并记录状态为 skipped
              if (this.record.status === STEP_STATUS.FAILURE) {
                return this.doSkip(item);
              }
              if (this.record.status === STEP_STATUS.TIMEOUT_FAILURE) {
                return this.doSkip(item);
              }
              return this.handleSrc(item);
            },
            onDone: {
              target,
            },
            onError: target,
          },
        };
      });

      const fetchMachine = createMachine({
        predictableActionArguments: true,
        id: 'step',
        initial: 'init',
        states,
      });

      const stepService = interpret(fetchMachine)
        .onTransition((state) => {
          this.logger?.debug(`step: ${state.value}`);
        })
        .start();
      stepService.send('INIT');
    });
  }
  private report() {
    const pluginSteps = filter(this.context.steps, o => has(o, 'plugin'))
    const plugin = map(pluginSteps, o => get(o, 'info'))
    execDaemon('report.js', { type: EReportType.command, userAgent: getUserAgent(), plugin: join(plugin, ',') });
  }
  private getLogger(filePath: string, itemLogConfig?: any) {
    const logConfig = this.options.logConfig as ILogConfig;
    const { customLogger, logPrefix, logLevel, eol } = logConfig;
    const { inputs } = this.options;
    if (customLogger) {
      debug('use custom logger');
      return (this.logger = customLogger);
    }
    const secrets = inputs?.secrets ? values(inputs.secrets) : [];
    const cloudSecrets = inputs?.cloudSecrets ? values(inputs.cloudSecrets) : [];
    const newSecrets = [...secrets, ...cloudSecrets];
    const gitToken = get(inputs, 'git.token');
    return new EngineLogger({
      file: logPrefix && path.join(logPrefix, filePath),
      level: logLevel,
      eol: lodash.get(itemLogConfig, 'eol', eol),
      secrets: gitToken ? [newSecrets, gitToken] : newSecrets,
    });
  }
  private async doOss(filePath: string) {
    const logConfig = this.options.logConfig as ILogConfig;
    const { logPrefix, ossConfig } = logConfig;
    if (ossConfig && logPrefix) {
      debug('upload log to oss');
      await this.logger.oss({
        ...ossConfig,
        codeUri: path.join(logPrefix, filePath),
      });
    }
  }
  private async doPreRun(stepCount: string) {
    const { events } = this.options;
    if (!isFunction(events?.onPreRun)) return;
    const data = find(this.context.steps, (obj) => obj.stepCount === stepCount);
    debug(`onPreRun ${stepCount} start`);
    debug(`onPreRun data: ${stringify(data)}`);
    debug(`onPreRun context: ${stringify(this.context)}`);
    await events?.onPreRun?.(data as ISteps, this.context, this.logger);
    debug(`onPreRun ${stepCount} end`);
  }
  private async doPostRun(item: IStepOptions) {
    const { events } = this.options;
    if (!isFunction(events?.onPostRun)) return;
    const data = find(this.context.steps, (obj) => obj.stepCount === item.stepCount);
    debug(`onPostRun ${item.stepCount} start`);
    debug(`onPostRun data: ${stringify(data)}`);
    debug(`onPostRun context: ${stringify(this.context)}`);
    try {
      await events?.onPostRun?.(data as ISteps, this.context, this.logger);
      debug(`onPostRun ${item.stepCount} end`);
    } catch (error) {
      this.outputErrorLog(error as Error);
    }
  }
  private recordContext(item: IStepOptions, options: Record<string, any> = {}) {
    const { status, error, outputs, name, process_time } = options;
    this.context.stepCount = item.stepCount as string;

    this.context.steps = map(this.context.steps, (obj) => {
      if (obj.stepCount === item.stepCount) {
        if (status) {
          obj.status = status;
        }
        if (error) {
          obj.error = error;
          this.context.error = error;
        }
        if (outputs) {
          obj.outputs = outputs;
        }
        if (name) {
          obj.name = name;
        }
        if (has(options, 'process_time')) {
          obj.process_time = process_time;
        }
      }
      return obj;
    });
    if (!this.record.isInit) {
      this.record.isInit = true;
      this.context.steps = concat(this.record.initData, this.context.steps);
    }
  }
  cancel() {
    this.record.status = STEP_STATUS.CANCEL;
    this.record.editStatusAble = false;
    // kill child process, 后续的步骤正常执行，但状态标记为cancelled
    each(this.childProcess, (item) => {
      item.kill();
    });
    this.clearTimeout(); // 清除超时定时器
    this.clearGlobalTimeout(); // 清除全局超时定时器
  }
  private getFilterContext() {
    const { inputs = {} } = this.options;
    const { env = {} } = this.context;
    // secrets, cloudSecrets, git 等
    return {
      ...inputs,
      status: this.context.status,
      steps: this.record.steps,
      env: { ...inputs.env, ...env },
      inputs,
    };
  }
  private async doCompleted() {
    this.logger.info(TAG_MESSAGE.COMPLETED_START);
    this.context.completed = true;
    const filePath = getLogPath(COMPLETED_STEP_COUNT);
    this.logger = this.getLogger(filePath);
    this.logger.info(DEFAULT_COMPLETED_LOG);
    const { events } = this.options;
    if (isFunction(events?.onCompleted)) {
      try {
        await events?.onCompleted?.(this.context, this.logger);
      } catch (error) {
        this.outputErrorLog(error as Error);
        this.logger.info(TAG_MESSAGE.COMPLETED_FAIL);
      }
    }
    const totalTime = getProcessTime(this.startTime);
    if (this.context.performance) {
      this.context.performance.totalTime = totalTime;
      this.context.performance.taskStatus = this.record.status;
      this.context.performance.stepLength = this.context.steps.length;
    }
    this.clearTimeout(); // 清除超时定时器
    this.clearGlobalTimeout();
    await this.doOss(filePath);
    this.logger.info(TAG_MESSAGE.COMPLETED_SUCCESS);
  }
  private async handleSrc(item: IStepOptions) {
    this.logger.debug(`Starting step: ${item.stepCount}`);
    try {
      await this.doPreRun(item.stepCount as string);
      // 设置步骤超时定时器
      const stepTimeoutPromise = this.setupStepTimeout(item);
      const responsePromise = this.doSrc(item);
      const promises = [responsePromise, stepTimeoutPromise];
      if (this.globalTimeoutPromise) {
        promises.push(this.globalTimeoutPromise);
      }
      const response: any = await Promise.race(promises);
      if (this.stepTimeoutId) {
        clearTimeout(this.stepTimeoutId);
        this.stepTimeoutId = null;
      }
      // 如果已取消且if条件不成功，则不执行该步骤, 并记录状态为 cancelled
      const isCancel = item.if !== 'true' && this.record.status === STEP_STATUS.CANCEL;
      if (isCancel) return this.doCancel(item);
      // 记录全局的执行状态
      if (this.record.editStatusAble) {
        this.record.status = STEP_STATUS.SUCCESS;
      }
      // id 添加状态
      if (item.id) {
        this.record.steps = {
          ...this.record.steps,
          [item.id]: {
            status: STEP_STATUS.SUCCESS,
            outputs: response,
          },
        };
      }
      const process_time = getProcessTime(this.record.startTime);
      this.recordContext(item, { status: STEP_STATUS.SUCCESS, outputs: response, process_time });
      // 记录步骤耗时
      if (this.context.performance && this.context.performance.stepTimes) {
        this.context.performance.stepTimes[item.stepCount as string] = process_time;
      }
      await this.doPostRun(item);
      await this.doOss(getLogPath(item.stepCount as string));
    } catch (error: any) {
      if (this.stepTimeoutId) {
        clearTimeout(this.stepTimeoutId);
        this.stepTimeoutId = null;
      }
      // 检查是否是超时错误
      let status: IStatus;
      const isTimeoutError = error instanceof TimeoutError;
      if (isTimeoutError) {
        // 如果是超时错误，检查是否设置了 continue-on-error
        if (item['continue-on-error'] === true) {
          status = STEP_STATUS.ERROR_WITH_CONTINUE;
          // 不修改全局状态，允许继续执行后续步骤
          if (this.record.editStatusAble) {
            this.record.status = STEP_STATUS.ERROR_WITH_CONTINUE;
          }
        } else {
          // 如果没有设置 continue-on-error，设置状态为timeout-failure
          status = STEP_STATUS.TIMEOUT_FAILURE;
          // 更新全局状态
          if (this.record.editStatusAble) {
            this.record.status = STEP_STATUS.TIMEOUT_FAILURE;
            this.record.editStatusAble = false; // 超时失败后，全局状态不可再修改
          }
        }
      } else {
        // 非超时错误的原有逻辑
        status =
          item['continue-on-error'] === true
            ? STEP_STATUS.ERROR_WITH_CONTINUE
            : STEP_STATUS.FAILURE;
        // 记录全局的执行状态
        if (this.record.editStatusAble) {
          this.record.status = status as IStatus;
        }
        if (status === STEP_STATUS.FAILURE) {
          // 全局的执行状态一旦失败，便不可修改
          this.record.editStatusAble = false;
        }
      }
      if (item.id) {
        this.record.steps = {
          ...this.record.steps,
          [item.id]: {
            status,
          },
        };
      }
      const process_time = getProcessTime(this.record.startTime);
      const logPath = getLogPath(item.stepCount as string);
      if (this.context.performance && this.context.performance.stepTimes) {
        this.context.performance.stepTimes[item.stepCount as string] = process_time;
      }
      if (item['continue-on-error']) {
        // continue-on-error为true时，无论是超时还是其他错误都继续执行
        this.recordContext(item, { status, error, process_time });
        await this.doOss(logPath);
      } else {
        this.recordContext(item, { status, error, process_time });
        if (error instanceof Error) {
          this.outputErrorLog(error as Error);
        } else {
          this.outputErrorLog(new Error(error.stderr as string));
        }
        await this.doOss(logPath);
        const runItem = item as IRunOptions;
        const pluginItem = item as IPluginOptions;
        if (runItem.run) this.logger.info(TAG_MESSAGE.RUN_FAIL(item.name, item.id, runItem.run));
        else if (pluginItem.plugin) this.logger.info(TAG_MESSAGE.PLUGIN_FAIL(item.name, item.id, pluginItem.plugin));
        throw error;
      }
    }
  }
  private validateWorkingDirectory(path: string) {
    if (!fs.existsSync(path)) {
      throw new Error(`Invalid working directory: ${path}`);
    }
    if (!fs.statSync(path).isDirectory()) {
      throw new Error(`Path is not a directory: ${path}`);
    }
  }
  private outputErrorLog(error: Error) {
    const logConfig = this.options.logConfig as ILogConfig;
    const { customLogger } = logConfig;
    // 自定义logger, debug级别输出错误信息
    if (!isEmpty(customLogger)) {
      return this.logger.debug(error);
    }
    process.env['CLI_VERSION'] ? this.logger.debug(error) : this.logger.error(error.stack)
  }
  private async doSrc(item: IStepOptions) {
    const runItem = item as IRunOptions;
    const pluginItem = item as IPluginOptions;
    // run
    if (runItem.run) {
      debug(`run: ${runItem.run}`);
      let execPath = runItem['working-directory'] || this.context.cwd;
      execPath = path.isAbsolute(execPath) ? execPath : path.join(this.context.cwd, execPath);
      if (execPath) {
        this.validateWorkingDirectory(execPath);
      }
      this.logName(item);
      runItem.run = this.doArtTemplateCompile(runItem.run);
      this.logger.info(TAG_MESSAGE.RUN_START(runItem.name, runItem.id, runItem.run));
      const cp = command(runItem.run, { cwd: execPath, env: this.parseEnv(runItem), shell: true });
      this.childProcess.push(cp);
      const res = await this.onFinish(cp, runItem.stepCount as string);
      this.logger.info(TAG_MESSAGE.RUN_SUCCESS(runItem.name, runItem.id, runItem.run));
      return res;
    }
    // plugin
    if (pluginItem.plugin) {
      this.logger.info(TAG_MESSAGE.PLUGIN_START(pluginItem.name, pluginItem.id, pluginItem.plugin));
      const newEnv = this.parseEnv(runItem);
      for (const key in newEnv) {
        process.env[key] = newEnv[key];
      }
      debug(`plugin: ${pluginItem.plugin}`);
      this.logName(item);
      // onInit时，会安装plugin依赖
      const app = require(getPluginRequirePath(pluginItem.plugin));
      const newContext = { ...this.context, $variables: this.getFilterContext() };
      const newInputs = get(pluginItem, 'inputs', {});
      debug(`plugin inputs: ${stringify(newInputs)}`);
      debug(`plugin context: ${stringify(newContext)}`);
      try {
        const res = pluginItem.type === 'run'
          ? await this.doPluginRun(app, newInputs, newContext, this.logger)
          : await this.doPluginRun(app, newInputs, newContext, this.logger, true);
        this.logger.info(TAG_MESSAGE.PLUGIN_SUCCESS(pluginItem.name, pluginItem.id, pluginItem.plugin));
        return res;
      } catch (err) {
        const error = err as Error;
        execDaemon('report.js', { type: EReportType.exception, userAgent: getUserAgent(), plugin: pluginItem.info, message: error.message });
        throw error;
      }
    }
  }
  private async doPluginRun(app: any, inputs: any, context: any, logger: EngineLogger, postRun: boolean = false) {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    process.stdout.write = (chunk: any) => {
      stdout.push(chunk.toString());
      return true;
    };

    process.stderr.write = (chunk: any) => {
      stderr.push(chunk.toString());
      return true;
    };
    try {
      if (postRun) {
        return await app.postRun(inputs, context, logger);
      } else {
        return await app.run(inputs, context, logger);
      }
    } catch (err: any) {
      throw {
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        message: err.message
      };
    } finally {
      // 还原原始写入方法
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      // 将内容写回到process
      process.stdout.write(stdout.join(''));
      process.stderr.write(stderr.join(''));
    }
  }
  private parseEnv(item: IRunOptions) {
    const { inputs } = this.options;
    const newEnv = { ...inputs?.env, ...item.env };
    for (const key in newEnv) {
      const val = newEnv[key];
      newEnv[key] = typeof val === 'string' && val.length > 0 ? this.doArtTemplateCompile(val) : val;
    }

    return newEnv;
  }
  private doArtTemplateCompile(value: string) {
    const artTemplate = getArtTemplate(this.context);
    const newVal = replace(value, /\${{/g, '{{');
    return artTemplate.compile(newVal)(this.getFilterContext());
  }
  private async doSkip(item: IStepOptions) {
    // id 添加状态
    if (item.id) {
      this.record.steps = {
        ...this.record.steps,
        [item.id]: {
          status: STEP_STATUS.SKIP,
        },
      };
    }
    this.logName(item);
    this.recordContext(item, { status: STEP_STATUS.SKIP, process_time: 0 });
    await this.doOss(getLogPath(item.stepCount as string));
    return Promise.resolve();
  }
  private async doCancel(item: IStepOptions) {
    // id 添加状态
    if (item.id) {
      this.record.steps = {
        ...this.record.steps,
        [item.id]: {
          status: STEP_STATUS.CANCEL,
        },
      };
    }
    this.logName(item);
    this.recordContext(item, { status: STEP_STATUS.CANCEL, process_time: 0 });
    await this.doOss(getLogPath(item.stepCount as string));
    return Promise.resolve();
  }
  private doWarn() {
    const { inputs = {} } = this.options;
    let msg = '';
    if (inputs.steps) {
      msg = 'steps is a built-in fields, and the steps field in the inputs will be ignored.';
    }
    msg && this.logger.warn(msg);
  }
  private logName(item: IStepOptions) {
    // 打印 step 名称
    const runItem = item as IRunOptions;
    const pluginItem = item as IPluginOptions;
    let msg = '';
    if (runItem.run) {
      msg = runItem.name || `Run ${runItem.run}`;
    }
    if (pluginItem.plugin) {
      msg =
        pluginItem.name || `${pluginItem.type === 'run' ? 'Run' : 'Post Run'} ${pluginItem.plugin}`;
    }
    const isSkip = get(this.record, `${item.stepCount}.status`) === STEP_STATUS.SKIP;
    msg = isSkip ? `[skipped] ${msg}` : msg;
    this.recordContext(item, { name: msg });
    this.logger.debug(msg);
    this.doWarn();
  }
  private onFinish(cp: any, stepCount: string) {
    return new Promise((resolve, reject) => {
      const logger = this.getLogger(getLogPath(stepCount), { eol: '' });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      cp.stdout.on('data', (chunk: Buffer) => {
        logger.info(chunk.toString());
        stdout.push(chunk);
      });

      cp.stderr.on('data', (chunk: Buffer) => {
        logger.info(chunk.toString());
        stderr.push(chunk);
      });

      cp.on('finish', () => {
        const eol = lodash.get(this.options, 'logConfig.eol', os.EOL);
        logger.info(eol);
        logger.close();
      });

      cp.on('exit', (code: number) => {
        code === 0 || this.record.status === STEP_STATUS.CANCEL
          ? resolve({})
          : reject({
            stderr: Buffer.concat(stderr as any).toString(),
            stdout: Buffer.concat(stdout as any).toString(),
          });
      });
    });
  }
  // 步骤超时处理逻辑
  private setupStepTimeout(item: IStepOptions): Promise<never> {
    return new Promise((_, reject) => {
      // 优先使用step自身的超时设置，其次使用默认step超时设置
      const timeout = item.timeout || this.options.stepTimeout;
      if (timeout) {
        const timeoutInMs = timeout * 1000;
        this.stepTimeoutId = setTimeout(() => {
          this.handleStepTimeout(item, timeout, reject);
        }, timeoutInMs);
      }
    });
  }
  // 步骤超时处理的具体实现
  private handleStepTimeout(item: IStepOptions, timeout: number, reject: (reason?: any) => void) {
    const errorMsg = `Step '${item.stepCount}' timeout after ${timeout}s`;
    this.logger?.error(errorMsg);
    each(this.childProcess, (item) => {
      item.kill();
    });
    reject(new TimeoutError(errorMsg, item));
  }
  // 超时清理逻辑
  private clearTimeout() {
    if (this.stepTimeoutId) {
      clearTimeout(this.stepTimeoutId);
      this.stepTimeoutId = null;
    }
  }
  // 设置全局超时
  private setupGlobalTimeout() {
    const { timeout } = this.options;
    if (timeout) {
      const timeoutInMs = timeout * 1000;
      this.globalTimeoutPromise = new Promise((_, reject) => {
        this.globalTimeoutId = setTimeout(() => {
          const errorMsg = `Global timeout after ${timeout}s`;
          this.logger?.error(errorMsg);
          this.clearTimeout();
          each(this.childProcess, (item) => {
            item.kill();
          });
          reject(new TimeoutError(errorMsg));
        }, timeoutInMs);
      });
    }
  }
  // 清除全局超时
  private clearGlobalTimeout() {
    if (this.globalTimeoutId) {
      clearTimeout(this.globalTimeoutId);
      this.globalTimeoutId = null;
    }
  }
}

export default Engine;