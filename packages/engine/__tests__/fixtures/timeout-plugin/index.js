module.exports = {
  run: async (inputs, context, logger) => {
    // 模拟一个长时间运行的插件
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({ success: true });
      }, 5000); // 5秒延迟
    });
  }
};