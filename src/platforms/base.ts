export interface PostContent {
  content: string;
  title?: string;
  hashtags?: string[];
  mediaUrls?: string[];
  mediaType?: 'image' | 'video';
}

export interface Engagement {
  likes: number;
  comments: number;
  shares: number;
  impressions: number;
  clicks?: number;
}

export interface PlatformClient {
  readonly platform: string;
  readonly isConfigured: boolean;

  authenticate(): Promise<void>;
  post(content: PostContent): Promise<string | null>; // Returns post ID
  getEngagement?(postId: string): Promise<Engagement | null>;
  deletePost?(postId: string): Promise<void>;
}
