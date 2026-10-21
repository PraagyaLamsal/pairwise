import { useCallback, useEffect, useMemo, useState } from 'react';
import { COURSE_COLORS, type Course, type ResumeState, type SearchHit } from '@shared/courses';
import type { CourseFile } from '@shared/ipc';
import { Icon, type IconName } from '../../ui/icons';
import { ipc } from '../../ui/ipc';
import { useCourses, useIpcEvent, useSettings, useSnapshot } from '../../ui/hooks';
import { Button, Kbd, Modal, Pill, Select, Spinner, TextField } from '../../ui/kit';
import { InkRing } from '../../ui/ink';
import { WHATS_NEW } from '@shared/app-info';

/** Quick-add suggestions for the first run (the student's Fall 2026 Carleton courses). */
const SUGGESTIONS = [
  { code: 'COMP 1405', name: 'Introduction to Computer Science I' },
  { code: 'COMP 1805', name: 'Discrete Structures I' },
];

function fileIcon(kind: string): IconName {
  if (kind === 'slides') return 'slides';
  if (kind === 'transcript') return 'captions';
  if (kind === 'code') return 'keyboard';
  return 'file';
}

function relTime(ts?: number): string {
  if (!ts) return 'never';
  const d = Date.now() - ts;
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function IndexPill({ c }: { c: Course }) {
  const s = c.indexStatus;
  if (!c.folder) return <Pill tone="neutral">No folder linked</Pill>;
  if (s.state === 'indexing') return <Pill tone="tutor">Reading files… {s.files ? `${s.files} so far` : ''}</Pill>;
  if (s.state === 'error') return <Pill tone="bad">Couldn't read folder</Pill>;
  if (s.state === 'ready') return <Pill tone="ok">{s.files} files · {s.chunks} passages</Pill>;
  return <Pill tone="warn">Not read yet</Pill>;
}

export function Courses() {
  const [courses] = useCourses();
  const [settings] = useSettings();
  const snap = useSnapshot();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Course | 'new' | null>(null);
  const [prefill, setPrefill] = useState<{ code: string; name: string } | null>(null);

  const selected = useMemo(() => courses.find((c) => c.id === selectedId) ?? courses.find((c) => c.id === settings?.lastCourseId) ?? courses[0], [courses, selectedId, settings?.lastCourseId]);

  if (!courses.length) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <h1>Courses</h1>
            <p>Each course gets its own folder of slides, notes and assignment specs, so the tutor teaches the way your class does.</p>
          </div>
        </div>
        <div className="empty">
          <div className="hand-title">Pick a class and say hi.</div>
          <p>Add a course and link the folder where you keep its lecture slides, PDFs and transcripts.</p>
          <Button variant="primary" size="l" icon="plus" onClick={() => setEditing('new')}>
            Add a course
          </Button>
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <Button key={s.code} size="s" variant="ghost" icon="plus" onClick={() => { setPrefill(s); setEditing('new'); }}>
                {s.code}
              </Button>
            ))}
          </div>
        </div>
        <CourseEditor open={editing !== null} course={editing === 'new' ? null : editing} prefill={prefill} onClose={() => { setEditing(null); setPrefill(null); }} />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Courses</h1>
          <p>Choose a course, then start a session. The tutor sticks to that course's material.</p>
        </div>
      </div>
      {settings?.onboardingComplete && settings.whatsNewSeen !== WHATS_NEW.id && <WhatsNew onDone={() => void ipc.invoke('settings:update', { whatsNewSeen: WHATS_NEW.id })} />}
      <div className="course-layout">
        <div className="course-list">
          {courses.map((c, i) => (
            <button key={c.id} className={`course-tile ${selected?.id === c.id ? 'selected' : ''}`} onClick={() => setSelectedId(c.id)}>
              <span className="course-bar" style={{ background: c.color }} />
              <span>
                <div className="course-code">{c.code}</div>
                <div className="course-name">{c.name || 'Untitled course'}</div>
                <div className="course-status">
                  {snap.courseId === c.id && snap.status !== 'idle' ? <Pill tone="bad">● Live now</Pill> : <span>Last session {relTime(c.lastSessionAt)}</span>}
                </div>
              </span>
              {selected?.id === c.id && <InkRing key={c.id} seed={i * 13 + 5} />}
            </button>
          ))}
          <button className="add-tile" onClick={() => setEditing('new')}>
            <Icon name="plus" size={15} /> Add course
          </button>
        </div>
        {selected && <CourseDetail course={selected} onEdit={() => setEditing(selected)} />}
      </div>
      <CourseEditor open={editing !== null} course={editing === 'new' ? null : editing} prefill={prefill} onClose={() => { setEditing(null); setPrefill(null); }} />
    </div>
  );
}

/** Once, after an update: what she can do now that she couldn't before. */
function WhatsNew({ onDone }: { onDone: () => void }) {
  return (
    <section className="whats-new" aria-label="What's new">
      <div className="wn-head">
        <span className="hand">New:</span>
        <Button size="s" variant="ghost" onClick={onDone}>
          Got it
        </Button>
      </div>
      <div className="wn-items">
        {WHATS_NEW.items.map((it) => (
          <div key={it.title} className="wn-item">
            <Icon name={it.icon as IconName} size={15} />
            <div>
              <b>{it.title}</b>
              <span>{it.text}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CourseDetail({ course, onEdit }: { course: Course; onEdit: () => void }) {
  const snap = useSnapshot();
  const [settings] = useSettings();
  const [files, setFiles] = useState<CourseFile[]>([]);
  const [resume, setResume] = useState<ResumeState | null>(null);
  const [notes, setNotes] = useState<{ file: string; title: string; at: number }[]>([]);
  const [assignment, setAssignment] = useState<string>('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [f, r, n] = await Promise.all([
      ipc.invoke('courses:files', course.id).catch(() => [] as CourseFile[]),
      ipc.invoke('courses:resume', course.id).catch(() => null),
      ipc.invoke('session:recentNotes', course.id).catch(() => []),
    ]);
    setFiles(f);
    setResume(r);
    setNotes(n);
  }, [course.id]);

  useEffect(() => {
    void load();
    setAssignment('');
    setError(null);
  }, [load]);
  useIpcEvent('courses:indexProgress', (p) => p.courseId === course.id && p.status.state === 'ready' && void load());
  // A session just ended: its notes are new (they're written a moment later, in the background).
  useEffect(() => {
    if (snap.status === 'idle') void load();
  }, [snap.status, load]);
  useIpcEvent('session:notesWritten', (m) => m.courseId === course.id && void load());

  const live = snap.status !== 'idle' && snap.status !== 'error' && snap.courseId === course.id;

  const start = async (resumeIt: boolean) => {
    setStarting(true);
    setError(null);
    const r = await ipc.invoke('session:start', { courseId: course.id, resume: resumeIt, assignment: assignment || undefined });
    setStarting(false);
    if (!r.ok) setError(r.error ?? 'Could not start the session.');
  };

  const linkFolder = async () => {
    const folder = await ipc.invoke('courses:pickFolder');
    if (folder) await ipc.invoke('courses:update', course.id, { folder });
  };

  const assignmentOptions = [{ value: '', label: 'Normal tutoring' }, ...course.assignments.map((a) => ({ value: a, label: `Assignment: ${a.split('/').pop()}` }))];

  return (
    <section className="detail">
      <div className="detail-head">
        <div>
          <div className="detail-title">{course.code}</div>
          <div className="detail-sub">
            {course.name}
            {course.term ? <span className="muted"> · {course.term}</span> : null}
          </div>
        </div>
        <Button variant="ghost" size="s" icon="pen" onClick={onEdit}>
          Edit
        </Button>
      </div>

      <div className="start-zone">
        {live ? (
          <>
            <Button variant="danger" size="l" icon="stop" onClick={() => void ipc.invoke('session:end')}>
              End session
            </Button>
            <span className="muted">Session running — controls are in the floating bar.</span>
          </>
        ) : (
          <>
            <Button variant="primary" size="l" icon="play" disabled={starting} onClick={() => void start(false)}>
              {starting ? 'Starting…' : 'Start session'}
            </Button>
            {resume && (
              <Button variant="secondary" size="l" icon="replay" disabled={starting} onClick={() => void start(true)}>
                Pick up where we left off
              </Button>
            )}
            {course.assignments.length > 0 && <Select value={assignment} options={assignmentOptions} onChange={setAssignment} width={230} />}
            {settings && (
              <span className="muted" style={{ marginLeft: 'auto' }}>
                or press <Kbd accel={settings.shortcuts.toggleSession} small />
              </span>
            )}
          </>
        )}
        {resume?.summary && !live && (
          <div className="resume-note">
            <span className="hand">Last time:</span>
            {resume.summary}
            {resume.checks && resume.checks.total > 0 && (
              <span className="checks-chip" title="Ada's “Show me” questions last session">
                ✓ {resume.checks.right} of {resume.checks.total} quick check{resume.checks.total === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}
        {assignment && !live && (
          <div className="resume-note">
            Assignment mode: the tutor explains concepts and gives hints from the course material, but won't write answers you'd hand in.
          </div>
        )}
        {error && (
          <div className="resume-note" style={{ color: '#ff8a8e' }}>
            {error}
          </div>
        )}
      </div>

      <div className="detail-section">
        <h3>Course folder</h3>
        {course.folder ? (
          <div className="folder-row">
            <Icon name="folder" size={16} />
            <span className="folder-path" title={course.folder}>
              {course.folder}
            </span>
            <IndexPill c={course} />
            <Button size="s" variant="ghost" icon="refresh" onClick={() => void ipc.invoke('courses:index', course.id)} title="Read the folder again">
              {course.indexStatus.state === 'indexing' ? <Spinner size={11} /> : null}
            </Button>
            <Button size="s" variant="ghost" icon="external" onClick={() => void ipc.invoke('courses:openFolder', course.id)} title="Open in Finder" />
          </div>
        ) : (
          <div className="folder-row">
            <Icon name="folder" size={16} />
            <span className="folder-path" style={{ direction: 'ltr' }}>
              Link the folder with this course's slides, PDFs, notes and assignment specs.
            </span>
            <Button size="s" variant="primary" onClick={() => void linkFolder()}>
              Link folder
            </Button>
          </div>
        )}
      </div>

      {course.folder && course.indexStatus.state === 'ready' && <CourseKnowledge course={course} tutor={settings?.tutorName ?? 'Ada'} />}

      {files.length > 0 && (
        <div className="detail-section">
          <h3>Files the tutor can cite ({files.length})</h3>
          <div className="file-list">
            {files.map((f) => (
              <div className="file-row" key={f.path}>
                <Icon name={fileIcon(f.kind)} size={14} />
                <span className="name" title={f.path}>
                  {f.path}
                </span>
                {!f.indexed && <Pill tone="neutral">{course.indexStatus.skipped?.find((x) => x.file === f.path)?.reason ?? 'skipped'}</Pill>}
                <button className={`chip-toggle ${f.isAssignment ? 'on' : ''}`} onClick={() => void ipc.invoke('courses:toggleAssignment', course.id, f.path).then(load)} title="Mark as an assignment spec">
                  {f.isAssignment ? 'Assignment' : 'Mark as assignment'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {notes.length > 0 && (
        <div className="detail-section">
          <h3>Session notes</h3>
          <div className="file-list">
            {notes.map((n) => (
              <div className="file-row" key={n.file}>
                <Icon name="file" size={14} />
                <span className="name">{n.title}</span>
                <span className="muted">{relTime(n.at)}</span>
                <Button size="s" variant="ghost" icon="external" onClick={() => void ipc.invoke('notes:open', n.file)} />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** What the tutor knows about the course (its profile) and a box to try the course search. */
function CourseKnowledge({ course, tutor }: { course: Course; tutor: string }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const p = course.profile;
  const run = async () => {
    if (!q.trim()) return setHits(null);
    setHits(await ipc.invoke('courses:search', course.id, q).catch(() => []));
  };
  return (
    <div className="detail-section knowledge">
      <h3>
        What {tutor} knows about this course
        {p && <span className="muted"> · {p.generatedBy === 'gemini' ? 'summarized by Gemini' : 'from file names and headings'}</span>}
      </h3>
      {p ? (
        <div className="know-card">
          {p.summary && <p className="know-summary">{p.summary}</p>}
          {p.topics.length > 0 && (
            <div className="know-row">
              <span className="know-label">Topics</span>
              <div className="chips">
                {p.topics.slice(0, 14).map((t) => (
                  <span key={t.title} className="chip" title={t.source}>
                    {t.title}
                  </span>
                ))}
              </div>
            </div>
          )}
          {p.glossary.length > 0 && (
            <div className="know-row">
              <span className="know-label">Course terms</span>
              <div className="chips">
                {p.glossary.slice(0, 14).map((g) => (
                  <span key={g.term} className="chip term" title={`${g.definition}\n— ${g.source}`}>
                    {g.term}
                  </span>
                ))}
              </div>
            </div>
          )}
          {p.conventions.length > 0 && (
            <div className="know-row">
              <span className="know-label">Conventions</span>
              <span className="know-text">{p.conventions.slice(0, 4).join(' · ')}</span>
            </div>
          )}
          {p.laterTopics.length > 0 && (
            <div className="know-row">
              <span className="know-label">Not covered yet</span>
              <span className="know-text">{p.laterTopics.slice(0, 3).join(' · ')}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="know-card muted">Reading the material… the profile appears in a moment.</div>
      )}
      <div className="search-try">
        <Icon name="search" size={14} />
        <TextField value={q} onChange={setQ} placeholder={`Try a search, e.g. "${p?.glossary[0]?.term ?? p?.topics[0]?.title ?? 'recursion'}"`} onEnter={() => void run()} />
        <Button size="s" onClick={() => void run()}>
          Search
        </Button>
      </div>
      {hits && (
        <div className="hits">
          {hits.length === 0 && <div className="muted hit-empty">Nothing in the material matches — the tutor would say so and teach it the standard way.</div>}
          {hits.slice(0, 4).map((h) => (
            <div className="hit" key={h.chunk.id}>
              <div className="hit-cite">{h.chunk.cite}</div>
              <div className="hit-text">{h.chunk.text.replace(/\s+/g, ' ').slice(0, 220)}{h.chunk.text.length > 220 ? '…' : ''}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CourseEditor({ open, course, prefill, onClose }: { open: boolean; course: Course | null; prefill: { code: string; name: string } | null; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [term, setTerm] = useState('Fall 2026');
  const [folder, setFolder] = useState<string | undefined>();
  const [color, setColor] = useState(COURSE_COLORS[0]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCode(course?.code ?? prefill?.code ?? '');
    setName(course?.name ?? prefill?.name ?? '');
    setTerm(course?.term ?? 'Fall 2026');
    setFolder(course?.folder);
    setColor(course?.color ?? COURSE_COLORS[Math.floor(Math.random() * COURSE_COLORS.length)]);
    setConfirmDelete(false);
  }, [open, course, prefill]);

  const save = async () => {
    if (!code.trim()) return;
    if (course) await ipc.invoke('courses:update', course.id, { code, name, term, folder, color });
    else await ipc.invoke('courses:create', { code, name, term, folder, color });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={course ? `Edit ${course.code}` : 'Add a course'}
      footer={
        <>
          {course &&
            (confirmDelete ? (
              <Button variant="danger" icon="trash" onClick={() => void ipc.invoke('courses:delete', course.id).then(onClose)} style={{ marginRight: 'auto' }}>
                Delete for good
              </Button>
            ) : (
              <Button variant="ghost" icon="trash" onClick={() => setConfirmDelete(true)} style={{ marginRight: 'auto' }}>
                Delete course
              </Button>
            ))}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!code.trim()} onClick={() => void save()}>
            {course ? 'Save changes' : 'Add course'}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <label>Course code</label>
        <TextField value={code} onChange={setCode} placeholder="COMP 1405" autoFocus onEnter={() => void save()} />
        <label>Name</label>
        <TextField value={name} onChange={setName} placeholder="Introduction to Computer Science I" onEnter={() => void save()} />
        <label>Term</label>
        <TextField value={term} onChange={setTerm} placeholder="Fall 2026" />
        <label>Folder</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
          <span className="muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={folder}>
            {folder ?? 'None yet — you can link it later'}
          </span>
          <Button size="s" icon="folder" onClick={() => void ipc.invoke('courses:pickFolder').then((f) => f && setFolder(f))}>
            Choose…
          </Button>
        </div>
        <label>Color</label>
        <div className="swatches">
          {COURSE_COLORS.map((c) => (
            <button key={c} className={`swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Color ${c}`} />
          ))}
        </div>
      </div>
    </Modal>
  );
}
