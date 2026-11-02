import { useTranslation } from 'react-i18next';
import { PlaceholderScreen } from '../../components/placeholder-screen';

export default function ProfileScreen() {
  const { t } = useTranslation();
  return (
    <PlaceholderScreen title={t('screens.profile.title')} body={t('screens.profile.comingSoon')} />
  );
}
