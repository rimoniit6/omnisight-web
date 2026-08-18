'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmployeeCombobox } from '@/components/employees/employee-combobox';
import { toast } from 'sonner';

interface Device {
  id: string;
  name: string;
  hostname: string | null;
  operatingSystem: string | null;
  osVersion: string | null;
  processor: string | null;
  memory: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  status: string;
  employeeId: string | null;
}

interface DeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  device?: Device | null;
  onSaved: () => void;
}

export function DeviceDialog({ open, onOpenChange, device, onSaved }: DeviceDialogProps) {
  const isEdit = !!device;
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: '', hostname: '', operatingSystem: '', osVersion: '', processor: '',
    memory: '', ipAddress: '', macAddress: '', status: 'online', employeeId: '',
  });

  // Adjust form state when the target device or dialog visibility changes.
  // React's documented "adjusting state when a prop changes" pattern (guarded
  // setState during render) — avoids setState-in-effect entirely.
  const [prevDevice, setPrevDevice] = useState(device);
  const [prevOpen, setPrevOpen] = useState(open);
  if (device !== prevDevice || open !== prevOpen) {
    setPrevDevice(device);
    setPrevOpen(open);
    if (device) {
      setForm({
        name: device.name, hostname: device.hostname || '', operatingSystem: device.operatingSystem || '',
        osVersion: device.osVersion || '', processor: device.processor || '', memory: device.memory || '',
        ipAddress: device.ipAddress || '', macAddress: device.macAddress || '',
        status: device.status, employeeId: device.employeeId || '',
      });
    } else {
      setForm({ name: '', hostname: '', operatingSystem: '', osVersion: '', processor: '', memory: '', ipAddress: '', macAddress: '', status: 'online', employeeId: '' });
    }
  }

  const handleSave = async () => {
    if (!form.name) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      const url = isEdit ? `/api/devices/${device!.id}` : '/api/devices';
      const method = isEdit ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      if (!res.ok) throw new Error('Failed');
      toast.success(isEdit ? 'Device updated' : 'Device created');
      onSaved();
      onOpenChange(false);
    } catch {
      toast.error('Failed to save device');
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{isEdit ? 'Edit Device' : 'Add Device'}</DialogTitle></DialogHeader>
        <div className="grid gap-4 py-2 max-h-96 overflow-y-auto custom-scrollbar">
          <div className="grid gap-2"><Label>Name *</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2"><Label>Hostname</Label><Input value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} /></div>
            <div className="grid gap-2"><Label>OS</Label><Input value={form.operatingSystem} onChange={(e) => setForm({ ...form, operatingSystem: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2"><Label>Processor</Label><Input value={form.processor} onChange={(e) => setForm({ ...form, processor: e.target.value })} /></div>
            <div className="grid gap-2"><Label>Memory</Label><Input value={form.memory} onChange={(e) => setForm({ ...form, memory: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2"><Label>IP Address</Label><Input value={form.ipAddress} onChange={(e) => setForm({ ...form, ipAddress: e.target.value })} /></div>
            <div className="grid gap-2"><Label>MAC Address</Label><Input value={form.macAddress} onChange={(e) => setForm({ ...form, macAddress: e.target.value })} /></div>
          </div>
          <div className="grid gap-2">
            <Label>Assigned To</Label>
            <EmployeeCombobox
              value={form.employeeId || null}
              onValueChange={(v) => setForm({ ...form, employeeId: (v as string) ?? '' })}
              placeholder="Select employee"
              allowClear
              labelFormat="name-email"
              ariaLabel="Assigned employee"
            />
          </div>
          {isEdit && (
            <div className="grid gap-2">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="online">Online</SelectItem>
                  <SelectItem value="offline">Offline</SelectItem>
                  <SelectItem value="maintenance">Maintenance</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                  <SelectItem value="retired">Retired</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700">{saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}