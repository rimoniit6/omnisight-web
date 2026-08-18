'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmployeeCombobox } from '@/components/employees/employee-combobox';
import { toast } from 'sonner';

interface Department {
  id: string;
  name: string;
  description: string | null;
  status: string;
  managerId: string | null;
}

interface DepartmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  department?: Department | null;
  onSaved: () => void;
}

export function DepartmentDialog({ open, onOpenChange, department, onSaved }: DepartmentDialogProps) {
  const isEdit = !!department;
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', status: 'active', managerId: '' });

  // Adjust form state when the target department or dialog visibility changes.
  // React's documented "adjusting state when a prop changes" pattern (guarded
  // setState during render) — avoids setState-in-effect entirely.
  const [prevDepartment, setPrevDepartment] = useState(department);
  const [prevOpen, setPrevOpen] = useState(open);
  if (department !== prevDepartment || open !== prevOpen) {
    setPrevDepartment(department);
    setPrevOpen(open);
    if (department) {
      setForm({ name: department.name, description: department.description || '', status: department.status, managerId: department.managerId || '' });
    } else {
      setForm({ name: '', description: '', status: 'active', managerId: '' });
    }
  }

  const handleSave = async () => {
    if (!form.name) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      const url = isEdit ? `/api/departments/${department!.id}` : '/api/departments';
      const method = isEdit ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      if (!res.ok) throw new Error('Failed');
      toast.success(isEdit ? 'Department updated' : 'Department created');
      onSaved();
      onOpenChange(false);
    } catch {
      toast.error('Failed to save department');
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Department' : 'Add Department'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label>Name *</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label>Description</Label>
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
          </div>
          <div className="grid gap-2">
            <Label>Manager</Label>
            <EmployeeCombobox
              value={form.managerId || null}
              onValueChange={(v) => setForm({ ...form, managerId: (v as string) ?? '' })}
              placeholder="Select manager"
              allowClear
              labelFormat="name-email"
              ariaLabel="Department manager"
            />
          </div>
          {isEdit && (
            <div className="grid gap-2">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
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