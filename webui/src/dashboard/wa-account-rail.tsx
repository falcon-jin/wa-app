import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Info, Loader2, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { Link, NavLink } from 'react-router';
import type { LongConnectionState } from '../proto/byte/v/forge/waapp/v1/messaging';
import type { WAAccount } from '../proto/byte/v/forge/waapp/v1/profile';
import { waAccountID } from './wa-api';
import { WaAccountAvatar } from './wa-account-avatar';
import { WhatsAppIcon } from './wa-brand-icon';
import { WaConnectionDot } from './wa-connection-dot';
import { waAccountPath, waChatsPath } from './wa-route-paths';
import {
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from './ui';

type RailProps = { accounts: WAAccount[]; selectedID: string; avatarVersion: string; connections: Map<string, LongConnectionState>; loading: boolean; connectionsLoading: boolean; hasNextPage: boolean; loadingMore: boolean; onLoadMore: () => void };
type AccountItemProps = { account: WAAccount; selected: boolean; avatarVersion: string; connection?: LongConnectionState; loading: boolean };

const collapsedIconButtonClass = 'group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-12! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!';
const accountButtonClass = 'h-14 gap-2 p-1! group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-14! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-1!';
const footerButtonClass = 'group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:justify-center';
const collapsedTextClass = 'group-data-[collapsible=icon]:hidden';

export function WaAccountRail({ accounts, selectedID, avatarVersion, connections, loading, connectionsLoading, hasNextPage, loadingMore, onLoadMore }: RailProps) {
  const [query, setQuery] = useState('');
  const { state } = useSidebar();
  const expanded = state === 'expanded';
  const visibleAccounts = useFilteredAccounts(accounts, expanded ? query : '');
  return (
    <Sidebar collapsible="icon" aria-label="WA 账号" className="border-r border-border">
      <SidebarHeader className="border-b border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem><RailBrand /></SidebarMenuItem>
        </SidebarMenu>
        {expanded ? <RailSearch value={query} onChange={setQuery} /> : null}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="p-1">
          <SidebarGroupContent>
            <SidebarMenu>
              {loading ? <LoadingItems /> : null}
              {visibleAccounts.map((account) => {
                const id = waAccountID(account);
                return <AccountItem key={id} account={account} selected={id === selectedID} avatarVersion={avatarVersion} connection={connections.get(id)} loading={connectionsLoading} />;
              })}
            </SidebarMenu>
            {!loading && visibleAccounts.length === 0 ? <EmptyAccounts searching={query.trim() !== ''} /> : null}
            {expanded && hasNextPage ? <LoadMoreButton loading={loadingMore} onLoadMore={onLoadMore} /> : null}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarSeparator />
      <SidebarFooter>
        <RailFooter selectedID={selectedID} />
      </SidebarFooter>
      <SidebarRail aria-label={expanded ? '收起账号栏' : '展开账号栏'} title={expanded ? '收起账号栏' : '展开账号栏'} />
    </Sidebar>
  );
}

function RailBrand() {
  const { state, toggleSidebar } = useSidebar();
  if (state === 'collapsed') {
    return <SidebarMenuButton size="lg" tooltip="展开账号栏" aria-label="展开账号栏" className={collapsedIconButtonClass} onClick={toggleSidebar}><PanelLeftOpen className="size-6!" /></SidebarMenuButton>;
  }
  return (
    <div className="flex h-12 items-center justify-between rounded-md px-2">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-50"><WhatsAppIcon className="size-6" /></span>
      <Button variant="ghost" size="icon-sm" aria-label="收起账号栏" title="收起账号栏" onClick={toggleSidebar}><PanelLeftClose /></Button>
    </div>
  );
}

function RailSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <SidebarInput value={value} onChange={(event) => onChange(event.target.value)} placeholder="搜索手机号" aria-label="搜索账号" />
  );
}

function AccountItem({ account, selected, avatarVersion, connection, loading }: AccountItemProps) {
  const id = waAccountID(account);
  const title = waAccountPhoneLabel(account);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild size="lg" isActive={selected} tooltip={title} className={accountButtonClass}>
        <NavLink to={waChatsPath(id)} title={title} aria-label={title}>
          <span className="relative shrink-0">
            <WaAccountAvatar account={account} version={avatarVersion} size="lg" />
            <WaConnectionDot className="absolute bottom-0 right-0" connection={connection} loading={loading} />
          </span>
          <span className={`min-w-0 flex-1 ${collapsedTextClass}`}>
            <span className="block whitespace-nowrap text-sm font-medium tabular-nums">{title}</span>
          </span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function RailFooter({ selectedID }: { selectedID: string }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>{selectedID ? <FooterLink title="账号信息" to={waAccountPath(selectedID)}><Info /></FooterLink> : <SidebarMenuButton size="lg" disabled tooltip="账号信息" aria-label="账号信息" className={footerButtonClass}><Info /><span>账号信息</span></SidebarMenuButton>}</SidebarMenuItem>
      <SidebarMenuItem><FooterLink title="添加账号" to="/accounts/new"><Plus /></FooterLink></SidebarMenuItem>
    </SidebarMenu>
  );
}

function FooterLink({ children, title, to }: { children: ReactNode; title: string; to: string }) {
  return <SidebarMenuButton asChild size="lg" tooltip={title} className={footerButtonClass}><Link to={to} title={title} aria-label={title}>{children}<span>{title}</span></Link></SidebarMenuButton>;
}

function LoadMoreButton({ loading, onLoadMore }: { loading: boolean; onLoadMore: () => void }) {
  return <Button className="mt-2 w-full" variant="outline" onClick={onLoadMore} disabled={loading}>{loading ? <Loader2 className="size-4 animate-spin" /> : null}加载更多账号</Button>;
}

function LoadingItems() {
  return <><SidebarMenuItem><SidebarMenuSkeleton showIcon /></SidebarMenuItem><SidebarMenuItem><SidebarMenuSkeleton showIcon /></SidebarMenuItem></>;
}

function EmptyAccounts({ searching }: { searching: boolean }) {
  return <Empty className="mt-4 border-0 p-4"><EmptyHeader><EmptyTitle>{searching ? '没有匹配账号' : '还没有账号'}</EmptyTitle><EmptyDescription>{searching ? '没有匹配的已加载账号' : '添加账号后会显示在这里'}</EmptyDescription></EmptyHeader></Empty>;
}

function useFilteredAccounts(accounts: WAAccount[], query: string) {
  return useMemo(() => {
    const normalized = normalizeQuery(query);
    if (!normalized) return accounts;
    return accounts.filter((account) => normalizeQuery(waAccountPhoneSearchText(account)).includes(normalized));
  }, [accounts, query]);
}

function waAccountPhone(account: WAAccount) {
  const phone = account.phone;
  const callingCode = phoneCallingCode(phone?.country_calling_code || '');
  const nationalNumber = (phone?.national_number || '').trim();
  if (callingCode && nationalNumber) return `${callingCode} ${nationalNumber}`;
  return formatE164Number(phone?.e164_number || '', callingCode);
}

function waAccountPhoneSearchText(account: WAAccount) {
  const phone = account.phone;
  return `${waAccountPhone(account)} ${phone?.e164_number || ''} ${phone?.national_number || ''}`;
}

function formatE164Number(value: string, callingCode: string) {
  value = value.trim();
  if (!value || !callingCode || !value.startsWith(callingCode)) return value;
  const nationalNumber = value.slice(callingCode.length).trim();
  return nationalNumber ? `${callingCode} ${nationalNumber}` : value;
}

function phoneCallingCode(value: string) {
  value = value.trim();
  if (!value) return '';
  return value.startsWith('+') ? value : `+${value}`;
}

function waAccountPhoneLabel(account: WAAccount) {
  return waAccountPhone(account) || '未录入手机号';
}

function normalizeQuery(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}
