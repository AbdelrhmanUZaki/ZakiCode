import { useMemo, useState } from "react";
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import {
  VM_RESOURCE_SPEC_LIMITS,
  type VmHostResources,
  type VmResourceSpec,
  type VmTemplateToolsChoice,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

/**
 Spec panel before a first VM create: the host-resources line is always visible (you see the cost without expanding),
 Customize and base-image tools start collapsed, and empty values mean agent-vm defaults. Over-commit gets an amber
 warning, not a blocker (KVM over-commit degrades but works; the user knows their load better than a heuristic).
 */
export function RemoteConnectionVmSpecStep({
  workspacePath,
  hostResources,
  templateReady = true,
  onStart,
  onCancel,
}: {
  workspacePath: string;
  hostResources: VmHostResources;
  /** Shown when the base image is missing: a one-time build notice; Start builds it first, then creates. */
  templateReady?: boolean;
  onStart: (spec: VmResourceSpec, templateTools: VmTemplateToolsChoice) => void;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [memoryGb, setMemoryGb] = useState(3);
  const [cpus, setCpus] = useState(1);
  const [diskGb, setDiskGb] = useState(10);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsPreset, setToolsPreset] = useState<VmTemplateToolsChoice["preset"]>("minimal");
  const [toolsCustomList, setToolsCustomList] = useState("");

  const runningVmNote =
    hostResources.runningVms.length > 0
      ? intl.formatMessage(
          { id: "vm.specs.runningVmsNote" },
          {
            count: String(hostResources.runningVms.length),
            memory: hostResources.runningVms.reduce((sum, vm) => sum + vm.memoryGb, 0).toFixed(1),
          },
        )
      : null;

  const overMemory = customizeOpen && memoryGb > Math.max(0, hostResources.availableMemoryGb);
  const overCpus = customizeOpen && cpus > hostResources.logicalCpus;

  const spec = useMemo(() => ({ memoryGb, cpus, diskGb }), [memoryGb, cpus, diskGb]);

  const numberField = (
    labelId: string,
    value: number,
    onChange: (next: number) => void,
    limits: { min: number; max: number },
    suffix: string,
  ) => (
    <label className="flex min-w-28 flex-col gap-1 text-ui-sm text-foreground-subtle">
      <span>{intl.formatMessage({ id: labelId })}</span>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          value={value}
          min={limits.min}
          max={limits.max}
          step={1}
          onChange={(event) => {
            const next = Number.parseInt(event.target.value, 10);
            if (Number.isFinite(next)) {
              onChange(Math.min(limits.max, Math.max(limits.min, next)));
            }
          }}
          className="h-8 w-20 rounded-md border border-border bg-background px-2 text-ui-base text-foreground outline-none focus-visible:border-primary"
          data-testid={`vm-spec-${labelId.split(".").pop()}`}
        />
        <span className="text-ui-sm">{suffix}</span>
      </span>
    </label>
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div className="text-ui-base text-foreground">
        {intl.formatMessage({ id: "vm.specs.newVmFor" }, { path: workspacePath })}
      </div>

      <div className="rounded-xl border border-border bg-surface px-4 py-3 text-ui-sm text-foreground-subtle">
        <div data-testid="vm-spec-host-line">
          {intl.formatMessage(
            { id: "vm.specs.hostLine" },
            {
              available: hostResources.availableMemoryGb.toFixed(1),
              total: hostResources.totalMemoryGb.toFixed(1),
              cpus: String(hostResources.logicalCpus),
              disk: hostResources.diskFreeGb.toFixed(0),
            },
          )}
        </div>
        {runningVmNote ? <div className="mt-1">{runningVmNote}</div> : null}
        <div className="mt-1">{intl.formatMessage({ id: "vm.specs.defaultsSummary" })}</div>
      </div>

      {!templateReady ? (
        // First-machine bootstrap: explain up front when the base image is missing (built once; every later project VM
        // clones from it); Start stays a single button, streaming the build into the connection log.
        <div
          data-testid="vm-template-required"
          className="flex items-start gap-2 rounded-xl bg-warning/10 px-4 py-3 text-ui-sm text-warning"
        >
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0">
            <div>{intl.formatMessage({ id: "vm.template.requiredTitle" })}</div>
            <div className="mt-0.5">
              {intl.formatMessage({ id: "vm.template.requiredDescription" })}
            </div>
          </div>
        </div>
      ) : null}

      {!templateReady ? (
        // Base image preinstall tools: a one-time decision where the default is fine; collapsed so it does not bother
        // users who do not care. The choice maps to agent-vm setup --preinstall.
        <div className="rounded-xl border border-border">
          <button
            type="button"
            onClick={() => setToolsOpen((open) => !open)}
            className="flex w-full items-center justify-between px-4 py-3 text-ui-sm text-foreground-subtle hover:text-foreground"
            aria-expanded={toolsOpen}
          >
            <span>
              {intl.formatMessage({ id: "vm.template.toolsTitle" })}
              {toolsPreset !== "default" ? (
                <span className="ml-2 text-foreground">
                  {intl.formatMessage({
                    id:
                      toolsPreset === "minimal"
                        ? "vm.template.presetMinimalLabel"
                        : "vm.template.presetCustomLabel",
                  })}
                </span>
              ) : null}
            </span>
            <ChevronDownIcon
              className={cn("size-4 transition-transform", toolsOpen && "rotate-180")}
            />
          </button>
          {toolsOpen ? (
            <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
              <div className="flex flex-col gap-2">
                {(
                  [
                    {
                      value: "default",
                      labelId: "vm.template.presetDefaultLabel",
                      descId: "vm.template.presetDefaultDesc",
                    },
                    {
                      value: "minimal",
                      labelId: "vm.template.presetMinimalLabel",
                      descId: "vm.template.presetMinimalDesc",
                    },
                    {
                      value: "custom",
                      labelId: "vm.template.presetCustomLabel",
                      descId: "vm.template.presetCustomDesc",
                    },
                  ] as const
                ).map((preset) => (
                  <label
                    key={preset.value}
                    className="flex cursor-pointer items-start gap-2 text-ui-sm text-foreground-subtle"
                  >
                    <input
                      type="radio"
                      name="vm-template-tools"
                      value={preset.value}
                      checked={toolsPreset === preset.value}
                      onChange={() => setToolsPreset(preset.value)}
                      className="mt-1 accent-[var(--color-primary)]"
                      data-testid={`vm-template-preset-${preset.value}`}
                    />
                    <span className="min-w-0">
                      <span className="block text-foreground">
                        {intl.formatMessage({ id: preset.labelId })}
                      </span>
                      <span className="block">{intl.formatMessage({ id: preset.descId })}</span>
                    </span>
                  </label>
                ))}
              </div>
              {toolsPreset === "custom" ? (
                <label className="flex flex-col gap-1 text-ui-sm text-foreground-subtle">
                  <span>{intl.formatMessage({ id: "vm.template.customListLabel" })}</span>
                  <input
                    type="text"
                    value={toolsCustomList}
                    onChange={(event) => setToolsCustomList(event.target.value)}
                    placeholder="python,node,docker,gh"
                    className="h-8 rounded-md border border-border bg-background px-2 font-mono text-ui-base text-foreground outline-none focus-visible:border-primary"
                    data-testid="vm-template-custom-list"
                  />
                  <span className="text-ui-xs">
                    {intl.formatMessage({ id: "vm.template.customListHint" })}
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-xl border border-border">
        <button
          type="button"
          onClick={() => setCustomizeOpen((open) => !open)}
          className="flex w-full items-center justify-between px-4 py-3 text-ui-sm text-foreground-subtle hover:text-foreground"
          aria-expanded={customizeOpen}
        >
          {intl.formatMessage({ id: "vm.specs.customize" })}
          <ChevronDownIcon
            className={cn("size-4 transition-transform", customizeOpen && "rotate-180")}
          />
        </button>
        {customizeOpen ? (
          <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
            <div className="flex flex-wrap gap-4">
              {numberField(
                "vm.specs.memory",
                memoryGb,
                setMemoryGb,
                VM_RESOURCE_SPEC_LIMITS.memoryGb,
                "GB",
              )}
              {numberField(
                "vm.specs.cpus",
                cpus,
                setCpus,
                VM_RESOURCE_SPEC_LIMITS.cpus,
                intl.formatMessage({ id: "vm.specs.cpuUnit" }),
              )}
              {numberField(
                "vm.specs.disk",
                diskGb,
                setDiskGb,
                VM_RESOURCE_SPEC_LIMITS.diskGb,
                "GB",
              )}
            </div>
            {overMemory ? (
              <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui-sm text-warning">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                {intl.formatMessage(
                  { id: "vm.specs.overMemory" },
                  { available: hostResources.availableMemoryGb.toFixed(1) },
                )}
              </div>
            ) : null}
            {overCpus ? (
              <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui-sm text-warning">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                {intl.formatMessage(
                  { id: "vm.specs.overCpus" },
                  { cpus: String(hostResources.logicalCpus) },
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-auto flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="vm-spec-start"
          onClick={() =>
            onStart(
              spec,
              toolsPreset === "custom"
                ? { preset: "custom", customList: toolsCustomList }
                : { preset: toolsPreset },
            )
          }
        >
          {intl.formatMessage({ id: "vm.specs.startVm" })}
        </Button>
      </div>
    </div>
  );
}
