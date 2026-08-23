import { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";

export type ComposeTab = "chat" | "note" | "task";

export interface TaskDraft {
  title: string;
  scheduledAt: string;
  notes: string;
}

interface ChatNoteTaskTabsProps {
  activeTab: ComposeTab;
  onTabChange: (tab: ComposeTab) => void;

  chatSlot: ReactNode;

  noteDraft: string;
  onNoteDraftChange: (v: string) => void;
  onSubmitNote: () => void;
  noteSubmitting: boolean;
  noteEnabled: boolean;

  taskDraft: TaskDraft;
  onTaskDraftChange: (v: TaskDraft) => void;
  onSubmitTask: () => void;
  taskSubmitting: boolean;
  taskEnabled: boolean;
}

const NOTE_MAX = 2000;
const TASK_TITLE_MAX = 500;
const TASK_NOTES_MAX = 2000;

export function ChatNoteTaskTabs({
  activeTab,
  onTabChange,
  chatSlot,
  noteDraft,
  onNoteDraftChange,
  onSubmitNote,
  noteSubmitting,
  noteEnabled,
  taskDraft,
  onTaskDraftChange,
  onSubmitTask,
  taskSubmitting,
  taskEnabled,
}: ChatNoteTaskTabsProps) {
  const { t } = useI18n();

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => onTabChange(v as ComposeTab)}
      className="border-t border-border/50 shrink-0"
    >
      <div className="px-3 pt-2">
        <TabsList className="h-8" data-testid="compose-tabs-list">
          <TabsTrigger value="chat" className="text-xs px-3" data-testid="compose-tab-chat">
            {t("inbox.compose.chatTab")}
          </TabsTrigger>
          <TabsTrigger value="note" className="text-xs px-3" data-testid="compose-tab-note">
            {t("inbox.compose.noteTab")}
          </TabsTrigger>
          <TabsTrigger value="task" className="text-xs px-3" data-testid="compose-tab-task">
            {t("inbox.compose.taskTab")}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="chat" className="mt-0">
        {chatSlot}
      </TabsContent>

      <TabsContent value="note" className="mt-0 p-3 space-y-2" data-testid="compose-tab-content-note">
        <Textarea
          value={noteDraft}
          onChange={(e) => onNoteDraftChange(e.target.value.slice(0, NOTE_MAX))}
          placeholder={t("inbox.compose.notePlaceholder")}
          rows={4}
          maxLength={NOTE_MAX}
          disabled={!noteEnabled || noteSubmitting}
          className="rounded-lg text-sm"
          data-testid="note-textarea"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {noteDraft.length} / {NOTE_MAX}
          </span>
          <Button
            size="sm"
            onClick={onSubmitNote}
            disabled={!noteEnabled || noteSubmitting || !noteDraft.trim()}
            className="h-8 gap-1"
            data-testid="note-submit"
          >
            {noteSubmitting && <Loader2 className="w-3 h-3 animate-spin" />}
            {t("inbox.compose.saveNote")}
          </Button>
        </div>
        {!noteEnabled && (
          <p className="text-[11px] text-amber-700">{t("inbox.compose.noteDisabledHint")}</p>
        )}
      </TabsContent>

      <TabsContent value="task" className="mt-0 p-3 space-y-2" data-testid="compose-tab-content-task">
        <Input
          value={taskDraft.title}
          onChange={(e) =>
            onTaskDraftChange({ ...taskDraft, title: e.target.value.slice(0, TASK_TITLE_MAX) })
          }
          placeholder={t("inbox.compose.taskTitle")}
          maxLength={TASK_TITLE_MAX}
          disabled={!taskEnabled || taskSubmitting}
          className="h-9 rounded-lg text-sm"
          data-testid="task-title"
        />
        <Input
          type="datetime-local"
          value={taskDraft.scheduledAt}
          onChange={(e) => onTaskDraftChange({ ...taskDraft, scheduledAt: e.target.value })}
          disabled={!taskEnabled || taskSubmitting}
          className="h-9 rounded-lg text-sm"
          data-testid="task-scheduled-at"
        />
        <Textarea
          value={taskDraft.notes}
          onChange={(e) =>
            onTaskDraftChange({ ...taskDraft, notes: e.target.value.slice(0, TASK_NOTES_MAX) })
          }
          placeholder={t("inbox.compose.taskNotes")}
          rows={2}
          maxLength={TASK_NOTES_MAX}
          disabled={!taskEnabled || taskSubmitting}
          className="rounded-lg text-sm"
          data-testid="task-notes"
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={onSubmitTask}
            disabled={
              !taskEnabled ||
              taskSubmitting ||
              !taskDraft.title.trim() ||
              !taskDraft.scheduledAt
            }
            className="h-8 gap-1"
            data-testid="task-submit"
          >
            {taskSubmitting && <Loader2 className="w-3 h-3 animate-spin" />}
            {t("inbox.compose.createTask")}
          </Button>
        </div>
        {!taskEnabled && (
          <p className="text-[11px] text-amber-700">{t("inbox.compose.taskDisabledHint")}</p>
        )}
      </TabsContent>
    </Tabs>
  );
}
