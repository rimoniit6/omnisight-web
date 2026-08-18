'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useQuery } from '@tanstack/react-query';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useAuthStore } from '@/lib/store';

interface Employee {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  designation: string | null;
  status: string;
  departmentId: string | null;
  joinDate?: string | null;
  organizationId?: string;
  organization?: { id: string; name: string } | null;
}

interface EmployeeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee?: Employee | null;
  onSaved: () => void;
}

const STATUSES = ['active', 'inactive', 'archived'] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EmployeeDialog({ open, onOpenChange, employee, onSaved }: EmployeeDialogProps) {
  const isEdit = !!employee;
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', phone: '', designation: '',
    employeeId: '', departmentId: '', joinDate: '', status: 'active',
  });
  const authOrg = useAuthStore((s) => s.organization);

  const { data: departments } = useQuery<Array<{ id: string; name: string; manager?: { id: string } | null }>>({
    queryKey: ['departments'],
    queryFn: async () => {
      const res = await fetch('/api/departments');
      const json = await res.json();
      return json.data;
    },
  });

  // Adjust form state when the target employee or dialog visibility changes
  // (React's documented "adjusting state when a prop changes" pattern —
  // guarded setState during render; requires referentially stable `employee`).
  const [prevEmployee, setPrevEmployee] = useState(employee);
  const [prevOpen, setPrevOpen] = useState(open);
  if (employee !== prevEmployee || open !== prevOpen) {
    setPrevEmployee(employee);
    setPrevOpen(open);
    if (employee) {
      setForm({
        firstName: employee.firstName,
        lastName: employee.lastName,
        email: employee.email,
        phone: employee.phone || '',
        designation: employee.designation || '',
        employeeId: employee.employeeId,
        departmentId: employee.departmentId || '',
        joinDate: employee.joinDate ? String(employee.joinDate).slice(0, 10) : '',
        status: employee.status || 'active',
      });
    } else {
      setForm({
        firstName: '', lastName: '', email: '', phone: '', designation: '',
        employeeId: '', departmentId: '', joinDate: new Date().toISOString().split('T')[0],
        status: 'active',
      });
    }
  }

  const isManager = Boolean(
    employee && (departments || []).some((d) => d.manager?.id === employee.id)
  );

  const handleSave = async () => {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      toast.error('First and last name are required');
      return;
    }
    if (!form.email.trim() || !EMAIL_RE.test(form.email.trim())) {
      toast.error('Please enter a valid email address');
      return;
    }
    if (!isEdit && !form.employeeId.trim()) {
      toast.error('Employee ID is required');
      return;
    }
    setSaving(true);
    try {
      const url = isEdit ? `/api/employees/${employee!.id}` : '/api/employees';
      const method = isEdit ? 'PUT' : 'POST';
      const body = {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        phone: form.phone || null,
        designation: form.designation || null,
        departmentId: form.departmentId || null,
        ...(isEdit
          ? { status: form.status, joinDate: form.joinDate || null }
          : { employeeId: form.employeeId.trim(), joinDate: form.joinDate || null }),
      };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let message = 'Failed to save employee';
        try {
          const json = await res.json();
          if (json?.error) message = json.error;
        } catch { /* keep default */ }
        throw new Error(message);
      }
      toast.success(isEdit ? 'Employee updated' : 'Employee created');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save employee');
    } finally {
      setSaving(false);
    }
  };

  const orgName = employee?.organization?.name || authOrg?.name || '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Employee' : 'Add Employee'}</DialogTitle>
        </DialogHeader>

        {/* Personal Information */}
        <div className="grid gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Personal Information</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>First Name *</Label>
              <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label>Last Name *</Label>
              <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Email *</Label>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Phone</Label>
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+880 1XXX XXXXXX" />
            </div>
            <div className="grid gap-2">
              <Label>{isEdit ? 'Employee ID' : 'Employee ID *'}</Label>
              {isEdit ? (
                <div className="h-9 px-3 rounded-md border bg-muted/40 text-sm text-muted-foreground flex items-center">
                  {form.employeeId}
                </div>
              ) : (
                <Input value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })} placeholder="EMP-001" />
              )}
            </div>
          </div>
        </div>

        {/* Employment Information */}
        <div className="grid gap-2 mt-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Employment Information</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Organization</Label>
              <div className="h-9 px-3 rounded-md border bg-muted/40 text-sm text-muted-foreground flex items-center truncate">
                {orgName || '—'}
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Department</Label>
              <Select value={form.departmentId} onValueChange={(v) => setForm({ ...form, departmentId: v })}>
                <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>
                  {(departments || []).map((d: { id: string; name: string }) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Designation</Label>
              <Input value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} placeholder="Software Engineer" />
            </div>
            <div className="grid gap-2">
              <Label>Access Role</Label>
              <div className="h-9 px-3 rounded-md border bg-muted/40 text-sm flex items-center">
                {isManager ? (
                  <Badge variant="secondary" className="gap-1">Manager</Badge>
                ) : (
                  <span className="text-muted-foreground">Employee</span>
                )}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Join Date</Label>
              <Input type="date" value={form.joinDate} onChange={(e) => setForm({ ...form, joinDate: e.target.value })} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700">
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
