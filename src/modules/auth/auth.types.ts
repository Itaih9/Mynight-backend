export interface LoginSendOTPRequest {
  phoneNumber: string;
}

export interface LoginVerifyOTPRequest {
  phoneNumber: string;
  otp: string;
}

export interface RegisterSendOTPRequest {
  phoneNumber: string;
  email?: string;
  referralCode?: string;
}

export interface RegisterVerifyOTPRequest {
  phoneNumber: string;
  otp: string;
  partnerName1: string;
  partnerName2: string;
  weddingDate: string;
  packageName?: string;
}

export interface RegisterDirectRequest {
  phoneNumber?: string;
  partnerName1: string;
  partnerName2: string;
  weddingDate: string;
  referralCode?: string;
  packageName?: string;
}

export interface LoginWithPasswordRequest {
  phoneNumber?: string;
  email?: string;
  password: string;
}

export interface SetPasswordRequest {
  password: string;
  phoneNumber?: string;
  email?: string;
}

export interface UpdateProfileRequest {
  name?: string;
  email?: string;
}

export interface AuthResponse {
  user: {
    id: string;
    phoneNumber: string;
    name?: string;
    email?: string;
    partnerName1?: string;
    partnerName2?: string;
    weddingDate?: string;
    referralCode: string;
  };
  token: string;
  event?: {
    id: string;
    eventCode: string;
    customSlug?: string;
    isPaid: boolean;
    packageName?: string;
    sharingPermissions?: {
      showProPhotos: boolean;
      showGuestPhotos: boolean;
      showGuestStories: boolean;
    };
  };
}
