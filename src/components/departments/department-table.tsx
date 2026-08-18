'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MoreHorizontal, Pencil, Trash2, Users } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface Department {
  id: string;
  name: string;
  description: string | null;
  status: string;
  _count: { employees: number };
  manager: { id: string; firstName: string; lastName: string } | null;
}

interface DepartmentTableProps {
  departments: Department[];
  onEdit: (dept: Department) => void;
  onDelete: (id: string) => void;
}

export function DepartmentTable({ departments, onEdit, onDelete }: DepartmentTableProps) {
  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b">
              <th className="text-left px-3 md:px-4 py-2 md:py-3 font-medium text-muted-foreground">Department</th>
              <th className="text-left px-3 md:px-4 py-2 md:py-3 font-medium text-muted-foreground hidden md:table-cell">Manager</th>
              <th className="text-left px-3 md:px-4 py-2 md:py-3 font-medium text-muted-foreground">Employees</th>
              <th className="text-left px-3 md:px-4 py-2 md:py-3 font-medium text-muted-foreground">Status</th>
              <th className="text-right px-3 md:px-4 py-2 md:py-3 font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {departments.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No departments found</td>
              </tr>
            )}
            {departments.map((dept) => (
              <tr key={dept.id} className="hover:bg-muted/40 transition-colors">
                <td className="px-3 md:px-4 py-2 md:py-3">
                  <div>
                    <p className="font-medium">{dept.name}</p>
                    {dept.description && <p className="text-xs text-muted-foreground truncate max-w-48">{dept.description}</p>}
                  </div>
                </td>
                <td className="px-3 md:px-4 py-2 md:py-3 hidden md:table-cell">
                  <span className="text-sm">{dept.manager ? `${dept.manager.firstName} ${dept.manager.lastName}` : '—'}</span>
                </td>
                <td className="px-3 md:px-4 py-2 md:py-3">
                  <div className="flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium">{dept._count.employees}</span>
                  </div>
                </td>
                <td className="px-3 md:px-4 py-2 md:py-3">
                  <Badge
                    variant={dept.status === 'active' ? 'outline' : 'secondary'}
                    className={dept.status === 'active' ? 'bg-success/10 text-success border-success/25 capitalize' : 'bg-muted text-muted-foreground capitalize'}
                  >
                    {dept.status}
                  </Badge>
                </td>
                <td className="px-3 md:px-4 py-2 md:py-3 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="w-4 h-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onEdit(dept)}><Pencil className="mr-2 h-4 w-4" /> Edit</DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onClick={() => onDelete(dept.id)}><Trash2 className="mr-2 h-4 w-4" /> Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
