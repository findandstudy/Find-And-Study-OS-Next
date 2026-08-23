import { useEffect, useRef, useState } from "react";
import { Bold, Braces, Heading1, Heading2, Italic, List, ListOrdered, Pilcrow, Redo2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const COMMON_PLACEHOLDERS = [
  ["Signer name", "{{contract.signerName}}"],
  ["Signer email", "{{contract.signerEmail}}"],
  ["Contract date", "{{contract.date}}"],
  ["Agent name", "{{agent.firstName}} {{agent.lastName}}"],
  ["Agent company", "{{agent.businessName}}"],
  ["Agent email", "{{agent.email}}"],
] as const;

type Props = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

export function ContractRichTextEditor({ value, onChange, disabled = false }: Props) {
  const [mode, setMode] = useState<"visual" | "html">("visual");
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode === "visual" && editorRef.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = value;
    }
  }, [mode, value]);

  function run(command: string, argument?: string) {
    if (disabled) return;
    editorRef.current?.focus();
    document.execCommand(command, false, argument);
    onChange(editorRef.current?.innerHTML || "");
  }

  function insertPlaceholder(placeholder: string) {
    if (!placeholder || disabled) return;
    run("insertText", placeholder);
  }

  const tools = [
    { label: "Undo", icon: Undo2, command: "undo" },
    { label: "Redo", icon: Redo2, command: "redo" },
    { label: "Paragraph", icon: Pilcrow, command: "formatBlock", argument: "p" },
    { label: "Heading 1", icon: Heading1, command: "formatBlock", argument: "h1" },
    { label: "Heading 2", icon: Heading2, command: "formatBlock", argument: "h2" },
    { label: "Bold", icon: Bold, command: "bold" },
    { label: "Italic", icon: Italic, command: "italic" },
    { label: "Bullet list", icon: List, command: "insertUnorderedList" },
    { label: "Numbered list", icon: ListOrdered, command: "insertOrderedList" },
  ];

  return (
    <div className="rounded-lg border bg-background overflow-hidden">
      <div className="flex flex-wrap items-center gap-1 border-b bg-muted/30 p-2">
        <div className="flex rounded-md border bg-background p-0.5 mr-1">
          <Button type="button" size="sm" variant={mode === "visual" ? "secondary" : "ghost"} className="h-7 px-2" onClick={() => setMode("visual")}>Visual</Button>
          <Button type="button" size="sm" variant={mode === "html" ? "secondary" : "ghost"} className="h-7 px-2" onClick={() => setMode("html")}><Braces className="h-3.5 w-3.5 mr-1" /> HTML</Button>
        </div>
        {mode === "visual" && tools.map(({ label, icon: Icon, command, argument }) => (
          <Button key={label} type="button" size="icon" variant="ghost" className="h-8 w-8" title={label} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => run(command, argument)}>
            <Icon className="h-4 w-4" />
          </Button>
        ))}
        <div className="ml-auto min-w-[190px]">
          <Select onValueChange={insertPlaceholder} disabled={disabled || mode !== "visual"}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Insert field…" /></SelectTrigger>
            <SelectContent>
              {COMMON_PLACEHOLDERS.map(([label, placeholder]) => <SelectItem key={placeholder} value={placeholder}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      {mode === "visual" ? (
        <div
          ref={editorRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={event => onChange(event.currentTarget.innerHTML)}
          className="contract-editor min-h-[360px] max-h-[55vh] overflow-y-auto p-6 text-sm leading-7 outline-none prose prose-sm dark:prose-invert max-w-none [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:text-lg [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6"
        />
      ) : (
        <Textarea value={value} onChange={event => onChange(event.target.value)} disabled={disabled} rows={20} className="rounded-none border-0 font-mono text-xs focus-visible:ring-0" />
      )}
    </div>
  );
}
