import { useRef, useState } from 'react';
import type { DownloadCandidate, DownloadMode, DownloadSelection } from '../../shared/desktop';
import { formatBytes, kindLabels } from './MediaProgress';
import { Icon } from './Icon';

interface Group { key: string; label: string; variants: DownloadCandidate[] }
const MAX_SELECTION = 100;
interface SelectionProps {
  candidates: DownloadCandidate[]; pending: boolean; onSubmit: (mode: DownloadMode, selections: DownloadSelection[]) => void;
}
export function MediaSelection({ targetTitle, ...props }: SelectionProps & { targetTitle?: string }) {
  return targetTitle ? <WorkQualitySelection {...props} title={targetTitle} /> : <ResourceSelection {...props} />;
}

function WorkQualitySelection({ candidates, pending, onSubmit, title }: SelectionProps & { title: string }) {
  const [selected, setSelected] = useState(candidates[0]?.index);
  const candidate = candidates.find(item => item.index === selected) ?? candidates[0];
  return <section className="panel target-work" aria-label="链接对应的视频">
    <p className="target-work-title">{title}</p>
    <p className="help">已确认是链接中的视频，声音会自动处理。</p>
    <div className="target-quality"><label className="resource-select"><span>清晰度</span><select aria-label="清晰度" value={candidate?.index ?? ''} disabled={pending || !candidate} onChange={event => setSelected(Number(event.target.value))}>{candidates.map((item, index) => <option key={item.index} value={item.index}>{[item.height ? `${Math.min(item.width ?? item.height, item.height)}p` : `版本 ${index + 1}`, item.byteLength ? formatBytes(item.byteLength) : undefined, index === 0 ? '推荐' : undefined].filter(Boolean).join(' · ')}</option>)}</select></label>
      <button type="button" className="button primary" disabled={pending || !candidate} aria-busy={pending} onClick={() => { if (!pending && candidate) onSubmit('single', [{ candidateIndex: candidate.index }]); }}><Icon name="download" size={18} />下载视频</button>
    </div>
  </section>;
}

function ResourceSelection({ candidates, pending, onSubmit }: {
  candidates: DownloadCandidate[]; pending: boolean; onSubmit: (mode: DownloadMode, selections: DownloadSelection[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [variants, setVariants] = useState<Record<string, number>>({});
  const [audios, setAudios] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<string>();
  const groups = [...candidates.reduce((all, candidate) => {
    const key = candidate.groupKey ?? `resource-${candidate.index}`;
    if (!all.has(key)) {
      const prefix = candidate.kind === 'audio' ? '音频' : candidate.kind === 'unknown' ? '媒体' : '视频';
      all.set(key, { key, label: candidate.grouping === 'confirmed' && candidate.groupLabel ? candidate.groupLabel : `${prefix} ${String(all.size + 1).padStart(2, '0')}`, variants: [] });
    }
    all.get(key)!.variants.push(candidate); return all;
  }, new Map<string, Group>()).values()];
  const chosen = (group: Group) => group.variants.find(c => c.index === variants[group.key]) ?? group.variants[0];
  const active = groups.filter(group => selected.includes(group.key));
  const audioGroupKey = (index: number) => candidates.find(candidate => candidate.index === index)?.groupKey ?? `resource-${index}`;
  const audioOwner = (index: number, except: string) => active.find(group => {
    const assigned = audios[group.key];
    return group.key !== except && assigned && audioGroupKey(assigned) === audioGroupKey(index) && chosen(group).audioOptions?.includes(assigned);
  });
  const reservedBy = (group: Group) => group.variants.map(candidate => audioOwner(candidate.index, group.key)).find(Boolean);
  const available = groups.filter(group => !reservedBy(group)).slice(0, MAX_SELECTION);
  const allSelected = available.length > 0 && available.every(group => selected.includes(group.key));
  const allCheckbox = useRef<HTMLInputElement>(null);
  const toggle = (key: string) => {
    if (selected.includes(key)) setAudios(previous => ({ ...previous, [key]: 0 }));
    setSelected(previous => previous.includes(key) ? previous.filter(value => value !== key) : [...previous, key]);
  };
  const assignAudio = (group: Group, index: number) => {
    if (index && (!chosen(group).audioOptions?.includes(index) || audioOwner(index, group.key))) return;
    setAudios(previous => ({ ...previous, [group.key]: index }));
    const audioGroup = groups.find(item => item.variants.some(candidate => candidate.index === index));
    if (audioGroup) setSelected(previous => previous.filter(key => key !== audioGroup.key));
  };
  const submit = () => {
    if (pending || !active.length) return;
    onSubmit(active.length === 1 ? 'single' : 'batch', active.map(group => {
      const candidate = chosen(group), audioIndex = audios[group.key];
      return { candidateIndex: candidate.index, ...(audioIndex && candidate.audioOptions?.includes(audioIndex) ? { audioIndex } : {}) };
    }));
  };

  return <>
    <div className="inline-selection" aria-label="资源列表"><section className="panel resource-panel" aria-label="已发现的资源">
      <div className="selection-toolbar"><label><input type="checkbox" ref={element => { allCheckbox.current = element; if (element) element.indeterminate = !!active.length && !allSelected; }} checked={allSelected} disabled={pending || !groups.length} onChange={() => { if (allSelected) { setSelected([]); setAudios({}); } else setSelected(available.map(group => group.key)); }} />{groups.length > MAX_SELECTION ? '全选前 100 项' : '全选可用资源'}</label><span>{active.length >= MAX_SELECTION ? "一次最多下载 100 项" : ""}</span></div>
      {groups.some(group => chosen(group).grouping !== 'confirmed') && <div className="resource-warning"><Icon name="info" size={15} /><p>页面中可能有其他视频，请选择需要的内容。</p></div>}
      {!groups.length && <p className="catalog-notice">没有可供选择的资源，请取消本次任务后重新解析。</p>}
      <div className="resource-list">{groups.map((group, index) => {
        const candidate = chosen(group), checked = selected.includes(group.key), audioUsedBy = reservedBy(group);
        const disabled = pending || !!audioUsedBy || (active.length >= MAX_SELECTION && !checked);
        const audioChoices = candidates.filter(audio => candidate.audioOptions?.includes(audio.index));
        const choiceId = `resource-${index}`, detailId = `resource-detail-${index}`;
        return <article className={`resource ${checked ? 'selected' : ''}`} key={group.key} aria-label={group.label}>
          <div className="resource-row"><input type="checkbox" id={choiceId} checked={checked} disabled={disabled} onChange={() => toggle(group.key)} aria-label={`选择 ${group.label}`} /><span className={`media-icon ${candidate.kind === 'audio' ? 'audio' : ''}`}><Icon name={candidate.kind === 'audio' ? 'audio' : 'video'} size={19} /></span><div className="resource-name"><label htmlFor={choiceId}>{group.label}</label>{(audioUsedBy || audios[group.key]) && <span>{audioUsedBy ? `用于${audioUsedBy.label}` : '已添加声音'}</span>}</div><strong className="resource-size mono">{candidate.byteLength ? formatBytes(candidate.byteLength) : '—'}</strong><button type="button" className="button link detail-toggle" aria-label={`${expanded === group.key ? '收起' : '查看'}${group.label}详情`} aria-expanded={expanded === group.key} aria-controls={detailId} onClick={() => setExpanded(previous => previous === group.key ? undefined : group.key)}> {expanded === group.key ? '收起' : '设置'}<Icon name="chevron" size={13} /></button></div>
          {expanded === group.key ? <div className="resource-details" id={detailId}>
            <div className="details-summary"><span>{kindLabels[candidate.kind]} · {candidate.grouping === 'confirmed' ? '已确认关联' : '资源归属未确认'}</span><span>{describeVariant(candidate)}</span></div>
            {group.variants.length > 1 && <label className="resource-select"><span>版本 / 清晰度</span><select aria-label={`${group.label} 的版本`} value={candidate.index} disabled={pending} onChange={event => { setVariants(previous => ({ ...previous, [group.key]: Number(event.target.value) })); setAudios(previous => ({ ...previous, [group.key]: 0 })); }}>{group.variants.map(option => <option key={option.index} value={option.index}>{describeVariant(option)}</option>)}</select></label>}
            {candidate.kind === 'video' && audioChoices.length > 0 && <details className="advanced" key={group.key}><summary>声音设置<Icon name="chevron" size={14} /></summary><div className="advanced-body"><p>需要添加声音时，选择与视频对应的音频。</p><fieldset aria-label={`${group.label}的音频设置`} disabled={pending || !checked}>
              <label className="audio-option"><input type="radio" name={`audio-${index}`} checked={!audios[group.key]} onChange={() => assignAudio(group, 0)} /><span>使用原文件<small>保留视频原有的声音</small></span></label>
              {audioChoices.map(audio => { const owner = audioOwner(audio.index, group.key), label = groups.find(item => item.variants.some(variant => variant.index === audio.index))!.label; return <label className="audio-option" key={audio.index}><input type="radio" name={`audio-${index}`} checked={audios[group.key] === audio.index} disabled={!!owner} onChange={() => assignAudio(group, audio.index)} /><span>添加{label}<small>{owner ? `已用于${owner.label}` : `${describeVariant(audio)} · 手动关联至${group.label}`}</small></span></label>; })}
            </fieldset>{!checked && <p className="help">请先勾选这个视频，再设置音频。</p>}</div></details>}
            <p className="help">{candidate.kind === 'pair' ? '已关联对应音频，下载后自动合并。' : candidate.kind === 'audio' ? '此项仅保存音频文件。' : candidate.kind === 'muxed' ? '识别为完整视频，下载后检查声音与画面。' : '以下载后的轨道检查为准；仅有视频画面时会明确标记。'}</p>
          </div> : <div id={detailId} hidden />}
        </article>;
      })}</div>
    </section></div>
    <div className="selection-actions"><div className="dock-copy"><strong>已选择 <b className="mono">{active.length}</b> 项</strong><p>{active.length ? '' : '请选择要下载的内容。'}</p></div><button type="button" className="button primary" disabled={!active.length || pending} aria-busy={pending} onClick={submit}><Icon name="download" size={18} />下载所选 {active.length} 项</button></div>
  </>;
}

function describeVariant(candidate: DownloadCandidate): string {
  const quality = candidate.variantLabel ?? (candidate.width && candidate.height ? `${candidate.width} × ${candidate.height}` : candidate.kind === 'audio' ? '音频' : '清晰度未知');
  return [quality, candidate.codecs, candidate.durationSeconds ? `${Math.floor(candidate.durationSeconds / 60)}:${String(Math.floor(candidate.durationSeconds % 60)).padStart(2, '0')}` : undefined, candidate.byteLength ? formatBytes(candidate.byteLength) : undefined].filter(Boolean).join(' · ');
}
