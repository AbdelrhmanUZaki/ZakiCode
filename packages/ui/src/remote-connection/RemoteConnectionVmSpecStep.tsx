import { useMemo, useState } from "react";
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import {
  VM_RESOURCE_SPEC_LIMITS,
  type VmHostResources,
  type VmResourceSpec,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

/**
 * 首次创建 VM 前的规格面板：宿主资源行常驻可见（不展开也知道拿了多少），
 * Customize 默认折叠，值缺省即 agent-vm 默认。超卖只给 amber 警告不拦截
 * （KVM 超卖会劣化但可用；用户比启发式更清楚自己的负载）。
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
  /** 基础镜像缺失时显示一次性构建提示；Start 会先自动构建再创建。 */
  templateReady?: boolean;
  onStart: (spec: VmResourceSpec) => void;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [memoryGb, setMemoryGb] = useState(3);
  const [cpus, setCpus] = useState(1);
  const [diskGb, setDiskGb] = useState(10);

  const runningVmNote =
    hostResources.runningVms.length > 0
      ? intl.formatMessage(
          { id: "vm.specs.runningVmsNote" },
          {
            count: String(hostResources.runningVms.length),
            memory: hostResources.runningVms
              .reduce((sum, vm) => sum + vm.memoryGb, 0)
              .toFixed(1),
          },
        )
      : null;

  const overMemory =
    customizeOpen && memoryGb > Math.max(0, hostResources.availableMemoryGb);
  const overCpus = customizeOpen && cpus > hostResources.logicalCpus;

  const spec = useMemo(
    () => ({ memoryGb, cpus, diskGb }),
    [memoryGb, cpus, diskGb],
  );

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
        {intl.formatMessage(
          { id: "vm.specs.newVmFor" },
          { path: workspacePath },
        )}
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
        <div className="mt-1">
          {intl.formatMessage({ id: "vm.specs.defaultsSummary" })}
        </div>
      </div>

      {!templateReady ? (
        // 首台机器引导：缺基础镜像时提前说明（一次性构建，之后所有项目 VM
        // 都从它克隆）；Start 仍是一个按钮，构建过程流式进连接日志。
        <div
          data-testid="vm-template-required"
          className="flex items-start gap-2 rounded-xl bg-warning/10 px-4 py-3 text-ui-sm text-warning"
        >
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0">
            <div>
              {intl.formatMessage({ id: "vm.template.requiredTitle" })}
            </div>
            <div className="mt-0.5">
              {intl.formatMessage({ id: "vm.template.requiredDescription" })}
            </div>
          </div>
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
            className={cn(
              "size-4 transition-transform",
              customizeOpen && "rotate-180",
            )}
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
          onClick={() => onStart(spec)}
        >
          {intl.formatMessage({ id: "vm.specs.startVm" })}
        </Button>
      </div>
    </div>
  );
}
