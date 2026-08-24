'use client';

import { useState, useMemo, type ComponentProps } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DepartmentTable } from './department-table';
import { DepartmentDialog } from './department-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Plus, Search, Users, Building2, TrendingUp } from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

interface Department {
  id: string;
  name: string;
  description: string | null;
  status: string;
  _count: { employees: number };
  manager: { id: string; firstName: string; lastName: string } | null;
}

interface PerfItem {
  departmentId: string;
  departmentName: string;
  employeeCount: number;
  avgProductiveHours: number;
  totalProductiveHours: number;
  topPerformer: { name: string; hours: number } | null;
}

export function DepartmentsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editDept, setEditDept] = useState<Department | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const queryClient = useQueryClient();
  const { setCurrentPage, setDepartmentFilter } = useAppStore();

  const { data, isLoading } = useQuery<Department[]>({
    queryKey: ['departments'],
    queryFn: async () => {
      const res = await fetch('/api/departments');
      if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try {
          const json = await res.json();
          if (json?.error) message = json.error;
        } catch { /* keep default */ }
        throw new Error(message);
      }
      const json = await res.json();
      return json.data as Department[];
    },
  });

  const { data: perfData } = useQuery<PerfItem[]>({
    queryKey: ['departments-performance'],
    queryFn: async () => {
      const res = await fetch('/api/departments/performance');
      const json = await res.json();
      return json.data as PerfItem[];
    },
  });

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/departments/${id}`, { method: 'DELETE' });
      toast.success('Department deleted');
      queryClient.invalidateQueries({ queryKey: ['departments'] });
      queryClient.invalidateQueries({ queryKey: ['departments-performance'] });
    } catch {
      toast.error('Failed to delete department');
    }
  };

  const filteredDepts = useMemo(() => {
    if (!data) return [];
    if (!searchQuery.trim()) return data;
    const q = searchQuery.toLowerCase();
    return data.filter((d) => d.name.toLowerCase().includes(q));
  }, [data, searchQuery]);

  const maxAvgHours = useMemo(() => {
    if (!perfData || perfData.length === 0) return 1;
    return Math.max(...perfData.map((p) => p.avgProductiveHours), 1);
  }, [perfData]);

  const handleCardClick = (deptId: string) => {
    setDepartmentFilter(deptId);
    setCurrentPage('employees');
  };

  return (
    <div className="space-y-5" role="region" aria-label="Departments">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Departments</h2>
          <p className="text-sm text-muted-foreground mt-0.5 truncate">
            Organize your workforce by department{data ? ` — ${data.length} departments` : ''}
          </p>
        </div>
        <Button
          onClick={() => { setEditDept(null); setDialogOpen(true); }}
          className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm shrink-0"
        >
          <Plus className="w-4 h-4 mr-2" /> Add Department
        </Button>
      </div>

      {/* Search */}
      <div className="relative w-full sm:w-64">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search departments..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9 h-9"
        />
      </div>

      {/* Department Overview Cards */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 bg-muted/30 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredDepts.map((dept, idx) => {
            const empCount = dept._count.employees;
            return (
              <motion.div
                key={dept.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: idx * 0.04 }}
              >
                <Card
                  className="border cursor-pointer transition-all hover:shadow-md hover:border-primary/30 relative overflow-hidden"
                  onClick={() => handleCardClick(dept.id)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <Building2 className="w-4 h-4 text-primary" />
                      </div>
                      <Badge
                        variant={dept.status === 'active' ? 'outline' : 'secondary'}
                        className={dept.status === 'active'
                          ? 'bg-success/10 text-success border-success/25 text-[10px] capitalize'
                          : 'text-[10px] capitalize'}
                      >
                        {dept.status}
                      </Badge>
                    </div>
                    <h3 className="text-sm font-semibold mt-2 truncate">{dept.name}</h3>
                    {dept.manager && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {dept.manager.firstName} {dept.manager.lastName}
                      </p>
                    )}
                    <div className="flex items-center gap-1.5 mt-3">
                      <Users className="w-3 h-3 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground">
                        {empCount} {empCount === 1 ? 'employee' : 'employees'}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Department Performance Metrics */}
      {perfData && perfData.length > 0 && (
        <Card className="border shadow-sm">
          <CardContent className="p-4 md:p-6">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-semibold">Department Productivity</h2>
            </div>
            <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
              {perfData.map((dept) => {
                const pct = Math.round((dept.avgProductiveHours / maxAvgHours) * 100);
                return (
                  <div key={dept.departmentId} className="group">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-medium truncate">{dept.departmentName}</span>
                        <span className="text-[10px] text-muted-foreground shrink-0">{dept.employeeCount} people</span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        {dept.topPerformer && (
                          <span className="text-[10px] text-muted-foreground hidden sm:inline">
                            Top: {dept.topPerformer.name} ({dept.topPerformer.hours}h)
                          </span>
                        )}
                        <span className="text-xs font-semibold text-primary">{dept.avgProductiveHours}h avg</span>
                      </div>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Department Table */}
      <div>
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <span>All Departments</span>
          {searchQuery && (
            <Badge variant="secondary" className="text-[10px]">
              {filteredDepts.length} result{filteredDepts.length !== 1 ? 's' : ''}
            </Badge>
          )}
        </h2>
        {isLoading ? (
          <div className="border rounded-lg p-8 text-center text-muted-foreground">Loading departments...</div>
        ) : (
          <DepartmentTable
            departments={filteredDepts}
            onEdit={(dept) => { setEditDept(dept); setDialogOpen(true); }}
            onDelete={handleDelete}
          />
        )}
      </div>

      <DepartmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        department={editDept as unknown as ComponentProps<typeof DepartmentDialog>['department']}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ['departments'] });
          queryClient.invalidateQueries({ queryKey: ['departments-performance'] });
        }}
      />
    </div>
  );
}
