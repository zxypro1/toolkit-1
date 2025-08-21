import axios from 'axios';
import { REPORT_BASE_URL } from '../../constants';
import { EReportType } from '../../types';

interface IReportCommand {
  type: EReportType.command,
  userAgent: string;
  plugin: string;
}

interface IRecordException {
  type: EReportType.exception,
  userAgent: string;
  plugin: string;
  message: string;
}

interface IReportPerformance {
  type: EReportType.performance,
  userAgent: string;
  taskId:string, // 从环境变量获取任务ID
  performance: string; // JSON字符串化的性能数据,
  timestamp: number; // 当前时间戳
  reportUrl: string; // 用户自定义的性能上报URL
}

type IReportOptions = IReportCommand | IRecordException | IReportPerformance;

class Report {
  constructor(private options = {} as IReportOptions) { }
  async start() {
    const { type } = this.options;
    if (type === EReportType.command) {
      return await this.reportCommand();
    }
    if (type === EReportType.exception) {
      return await this.reportException();
    }
    // 新增性能数据上报处理
    if (type === EReportType.performance) {
      return await this.reportPerformance();
    }
  }
  async reportCommand() {
    const { type, userAgent, plugin } = this.options as IReportCommand;
    const url = `${REPORT_BASE_URL}?APIVersion=0.6.0&trackerType=${type}&userAgent=${userAgent}&plugin=${plugin}`;
    await this.report(url)
  }
  async reportException() {
    const { type, userAgent, plugin, message } = this.options as IRecordException;
    const url = `${REPORT_BASE_URL}?APIVersion=0.6.0&trackerType=${type}&userAgent=${userAgent}&plugin=${plugin}&message=${message}`;
    await this.report(url)
  }
  // 新增性能数据上报方法
  async reportPerformance() {
    const { userAgent, performance, taskId, timestamp, reportUrl } = this.options as IReportPerformance;
    const url = `${reportUrl}?APIVersion=0.6.0&trackerType=performance&userAgent=${userAgent}&taskId=${taskId}&performance=${performance}&timestamp=${timestamp}`;
    await this.report(url)
  }
  async report(url: string) {
    await axios.get(url, { timeout: 3000 });
  }
}

export default Report;