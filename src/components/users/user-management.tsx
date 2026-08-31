'use client';

import { useState, useCallback } from 'react';
import { motion, AnimatePresence, type Variants } from 'framer-motion';
import {
  Search,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  UserPlus,
  Shield,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  Lock,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogContent,
  DialogFooter,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';

import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useAuthFetch } from '@/hooks/use-auth-fetch';
import { useAuthStore } from '@/lib/store';
import { toast } from 'sonner';
import { ChangePasswordDialog } from '@/components/auth/change-password-dialog';
import { AvatarUpload } from '@/components/upload/avatar-upload';
import { formatDistanceToNow } from 'date-fns';

// ─── Types ───────────────────────────────────────────────────────────────

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  roleLabel: string;
  avatar: string | null;
  isActive: boolean;
  lastLogin: string | null;
  createdAt: string;
  organizationId: string | null;
}

interface UsersResponse {
  users: User[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

interface UserFormData {
  name: string;
  email: string;
  password: string;
  role: string;
}

const emptyFormData: UserFormData = {
  name: '',
  email: '',
  password: '',
  role: 'viewer',
};

// ─── Role badge colors ────────────────────────────────────────────────────

const roleBadgeStyles: Record<string, string> = {
  super_admin: 'bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-100',
  org_admin: 'bg-blue-100 text-blue-700 border-blue-200 hover:bg-blue-100',
  admin: 'bg-blue-100 text-blue-700 border-blue-200 hover:bg-blue-100',
  owner: 'bg-purple-100 text-purple-700 border-purple-200 hover:bg-purple-100',
  manager: 'bg-orange-100 text-orange-700 border-orange-200 hover:bg-orange-100',
  viewer: 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-100',
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatLastLogin(date: string | null): string {
  if (!date) return 'Never';
  try {
    return formatDistanceToNow(new Date(date), { addSuffix: true });
  } catch {
    return '—';
  }
}

// ─── Row animation ────────────────────────────────────────────────────────

const rowVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.03, duration: 0.2, ease: 'easeOut' },
  }),
  exit: { opacity: 0, y: -6, transition: { duration: 0.15 } },
};

// ─── Component ────────────────────────────────────────────────────────────

export function UserManagement() {
  const authFetch = useAuthFetch();
  const currentUser = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  // Filters
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('__all__');
  const [page, setPage] = useState(1);
  const limit = 20;

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [formData, setFormData] = useState<UserFormData>(emptyFormData);

  const isEditing = editingUser !== null;

  // ─── Fetch users ────────────────────────────────────────────────────────
  const { data, isLoading, isError } = useQuery<UsersResponse>({
    queryKey: ['users', search, roleFilter, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (search) params.set('search', search);
      if (roleFilter !== '__all__') params.set('role', roleFilter);
      return authFetch<UsersResponse>(`/api/auth/users?${params.toString()}`);
    },
  });

  const users = data?.users ?? [];
  const pagination = data?.pagination;

  // ─── Create user mutation ───────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (body: UserFormData) =>
      authFetch('/api/auth/users', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success('User created successfully');
      closeDialog();
    },
    onError: (err: unknown) => {
      const message =
        (err as { error?: string })?.error ||
        (err as Error)?.message ||
        'Failed to create user';
      toast.error(message);
    },
  });

  // ─── Update user mutation ───────────────────────────────────────────────
  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<UserFormData> & { isActive?: boolean } }) =>
      authFetch(`/api/auth/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success('User updated successfully');
      closeDialog();
    },
    onError: (err: unknown) => {
      const message =
        (err as { error?: string })?.error ||
        (err as Error)?.message ||
        'Failed to update user';
      toast.error(message);
    },
  });

  // ─── Delete (deactivate) user mutation ───────────────────────────────────
  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      authFetch(`/api/auth/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success('User deactivated successfully');
    },
    onError: (err: unknown) => {
      const message =
        (err as { error?: string })?.error ||
        (err as Error)?.message ||
        'Failed to deactivate user';
      toast.error(message);
    },
  });

  // ─── Toggle active status ──────────────────────────────────────────────
  const handleToggleActive = useCallback(
    (user: User) => {
      updateMutation.mutate({
        id: user.id,
        body: { name: user.name, role: user.role, isActive: !user.isActive },
      });
    },
    [updateMutation],
  );

  // ─── Dialog helpers ────────────────────────────────────────────────────
  const openCreateDialog = () => {
    setEditingUser(null);
    setFormData(emptyFormData);
    setDialogOpen(true);
  };

  const openEditDialog = (user: User) => {
    setEditingUser(user);
    setFormData({
      name: user.name,
      email: user.email,
      password: '',
      role: user.role,
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingUser(null);
    setFormData(emptyFormData);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (isEditing) {
      const body: Partial<UserFormData> = {
        name: formData.name,
        role: formData.role,
      };
      // Only include password if user typed one
      if (formData.password) {
        body.password = formData.password;
      }
      updateMutation.mutate({ id: editingUser.id, body });
    } else {
      createMutation.mutate(formData);
    }
  };

  const handleDelete = (user: User) => {
    deleteMutation.mutate(user.id);
  };

  const isFormSubmitting = createMutation.isPending || updateMutation.isPending;

  return (
    <Card className="falcon-card overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Shield className="size-5 text-primary" />
          User Management
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ─── Toolbar ──────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 items-center gap-2">
            {/* Search */}
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                placeholder="Search users…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="pl-9 h-9"
              />
            </div>

            {/* Role filter */}
            <Select
              value={roleFilter}
              onValueChange={(v) => {
                setRoleFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-[140px] h-9">
                <SelectValue placeholder="All roles" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Roles</SelectItem>
                <SelectItem value="org_admin">Organization Admin</SelectItem>
                <SelectItem value="manager">Manager</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Add user + change own password */}
          <div className="flex items-center gap-2">
            <ChangePasswordDialog>
              <Button variant="outline" size="sm" className="gap-1.5">
                <Lock className="size-3.5" />
                Change Password
              </Button>
            </ChangePasswordDialog>

            <Button onClick={openCreateDialog} size="sm" className="gap-1.5">
              <Plus className="size-3.5" />
              Add User
            </Button>
          </div>
        </div>

        {/* ─── Table ────────────────────────────────────────────────────── */}
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead className="w-[240px]">Name</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead className="w-[120px]">Role</TableHead>
                <TableHead className="w-[100px]">Status</TableHead>
                <TableHead className="hidden lg:table-cell w-[130px]">Last Login</TableHead>
                <TableHead className="w-[60px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                // Skeleton rows
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Skeleton className="size-8 rounded-full" />
                        <Skeleton className="h-4 w-24" />
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-4 w-36" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-12" />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <Skeleton className="h-4 w-20" />
                    </TableCell>
                    <TableCell className="text-right">
                      <Skeleton className="h-8 w-8 rounded ml-auto" />
                    </TableCell>
                  </TableRow>
                ))
              ) : isError ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    Failed to load users. Please try again.
                  </TableCell>
                </TableRow>
              ) : users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <UserPlus className="size-8 opacity-40" />
                      <p className="text-sm">No users found</p>
                      {search && <p className="text-xs">Try a different search term</p>}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                <AnimatePresence mode="popLayout">
                  {users.map((user, i) => (
                    <motion.tr
                      key={user.id}
                      custom={i}
                      variants={rowVariants}
                      initial="hidden"
                      animate="visible"
                      exit="exit"
                      className="hover:bg-muted/50 border-b transition-colors"
                    >
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <AvatarUpload
                            currentAvatar={user.avatar}
                            entityId={user.id}
                            entityType="user"
                            name={user.name}
                            size="sm"
                            onUpdated={() => queryClient.invalidateQueries({ queryKey: ['users'] })}
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{user.name}</p>
                            <p className="text-xs text-muted-foreground md:hidden truncate">{user.email}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className="text-sm text-muted-foreground truncate block max-w-[220px]">
                          {user.email}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={roleBadgeStyles[user.role] || roleBadgeStyles.viewer}
                        >
                          {user.roleLabel}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={user.isActive}
                            onCheckedChange={() => handleToggleActive(user)}
                            disabled={updateMutation.isPending}
                            aria-label={`Toggle ${user.name} active status`}
                          />
                          <span
                            className={`text-xs font-medium ${
                              user.isActive ? 'text-emerald-600' : 'text-red-500'
                            }`}
                          >
                            {user.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <span className="text-xs text-muted-foreground">
                          {formatLastLogin(user.lastLogin)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-8">
                              <MoreVertical className="size-4" />
                              <span className="sr-only">Actions</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem
                              onClick={() => openEditDialog(user)}
                              className="gap-2"
                            >
                              <Pencil className="size-3.5" />
                              Edit User
                            </DropdownMenuItem>
                            {user.id !== currentUser?.id && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => handleDelete(user)}
                                  className="gap-2 text-red-600 focus:text-red-600"
                                >
                                  <Trash2 className="size-3.5" />
                                  Deactivate
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              )}
            </TableBody>
          </Table>
        </div>

        {/* ─── Pagination ──────────────────────────────────────────────── */}
        {pagination && pagination.pages > 1 && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Showing {(pagination.page - 1) * pagination.limit + 1}–
              {Math.min(pagination.page * pagination.limit, pagination.total)} of{' '}
              {pagination.total} users
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="size-4" />
              </Button>
              {Array.from({ length: pagination.pages }, (_, idx) => idx + 1)
                .filter(
                  (p) =>
                    p === 1 ||
                    p === pagination!.pages ||
                    Math.abs(p - page) <= 1,
                )
                .reduce<(number | 'ellipsis')[]>((acc, p, idx, arr) => {
                  if (idx > 0 && p - arr[idx - 1] > 1) {
                    acc.push('ellipsis');
                  }
                  acc.push(p);
                  return acc;
                }, [])
                .map((item, idx) =>
                  item === 'ellipsis' ? (
                    <span key={`ellipsis-${idx}`} className="px-1 text-xs">
                      …
                    </span>
                  ) : (
                    <Button
                      key={item}
                      variant={item === page ? 'default' : 'outline'}
                      size="icon"
                      className="size-8"
                      onClick={() => setPage(item)}
                    >
                      {item}
                    </Button>
                  ),
                )}
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={page >= pagination.pages}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      {/* ─── Create / Edit Dialog ───────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {isEditing ? (
                <>
                  <Pencil className="size-4 text-primary" />
                  Edit User
                </>
              ) : (
                <>
                  <UserPlus className="size-4 text-primary" />
                  Create User
                </>
              )}
            </DialogTitle>
          </DialogHeader>

          <motion.form
            onSubmit={handleSubmit}
            className="space-y-4"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="user-name">Name</Label>
              <Input
                id="user-name"
                placeholder="Full name"
                value={formData.name}
                onChange={(e) =>
                  setFormData((f) => ({ ...f, name: e.target.value }))
                }
                required
              />
            </div>

            {/* Email */}
            <div className="space-y-2">
              <Label htmlFor="user-email">Email</Label>
              <Input
                id="user-email"
                type="email"
                placeholder="user@example.com"
                value={formData.email}
                onChange={(e) =>
                  setFormData((f) => ({ ...f, email: e.target.value }))
                }
                required
                disabled={isEditing}
              />
              {isEditing && (
                <p className="text-xs text-muted-foreground">
                  Email cannot be changed after creation.
                </p>
              )}
            </div>

            {/* Password */}
            <div className="space-y-2">
              <Label htmlFor="user-password">
                Password {isEditing && <span className="text-muted-foreground font-normal">(leave blank to keep)</span>}
              </Label>
              <Input
                id="user-password"
                type="password"
                placeholder={isEditing ? '••••••••' : 'Minimum 8 characters'}
                value={formData.password}
                onChange={(e) =>
                  setFormData((f) => ({ ...f, password: e.target.value }))
                }
                minLength={isEditing ? undefined : 8}
                required={!isEditing}
              />
            </div>

            {/* Role */}
            <div className="space-y-2">
              <Label htmlFor="user-role">Role</Label>
              <Select
                value={formData.role}
                onValueChange={(v) =>
                  setFormData((f) => ({ ...f, role: v }))
                }
              >
                <SelectTrigger id="user-role" className="w-full">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="org_admin">Organization Admin</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeDialog}
                disabled={isFormSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isFormSubmitting} className="min-w-[100px]">
                {isFormSubmitting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : isEditing ? (
                  'Save Changes'
                ) : (
                  'Create User'
                )}
              </Button>
            </DialogFooter>
          </motion.form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
