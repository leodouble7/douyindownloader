export function FailureMessage({ message, alert = false }: { message: string; alert?: boolean }) {
  const technical = message.length > 80 || /https?:|HTTP|ffmpeg|ffprobe|Authorization|Error:|transport|sourceRequest/i.test(message);
  return <div className="failure-message"><p className="error-text" role={alert ? 'alert' : undefined}>{technical ? '下载未成功，请重试。' : message || '下载未成功，请重试。'}</p>{technical && <details className="download-details"><summary>查看原因</summary><p>{message}</p></details>}</div>;
}
