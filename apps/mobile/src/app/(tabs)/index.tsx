import { useTranslation } from 'react-i18next';
import { PlaceholderScreen } from '../../components/placeholder-screen';

export default function HomeScreen() {
  const { t } = useTranslation();
  return (
    <PlaceholderScreen
      testID="screen-home"
      title={t('screens.home.title')}
      body={t('screens.home.comingSoon')}
    />
  );
}
