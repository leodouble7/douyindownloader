import { Icon } from './Icon';

export function TaskContext({ directory }: { directory: string }) {
  return <p className="save-location"><Icon name="folder" size={16} /><span>保存到</span><strong>{directory}</strong></p>;
}
